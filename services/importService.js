const { Op } = require("sequelize");
const { sequelize, Account, Transaction, Setting, ImportRef } = require("../models");
const { EXPENSE_CATEGORIES } = require("../constants/categories");
const { adjustAccountForTransaction, checkingEffect, applyImportedRow } = require("./accountBalanceService");
const { getBalanceAnchor } = require("./balanceAnchorService");
const { getAppBalance } = require("./reconcileService");
const {
  snapshotArchivedBalances,
  assertArchivedBalancesUnchanged,
} = require("./accountArchiveService");
const { getPrimaryCheckingAccount } = require("./checkingService");
const { loadRules, applyRules } = require("./ruleService");
const { HttpError } = require("../middleware/errorHandler");
const { normalizeMerchantName } = require("../utils/merchantNormalizer");
const { importClientRef, titlesSimilar, daysBetween } = require("../utils/csvImport");

const MATCH_WINDOW_DAYS = 3;
const mappingKey = (accountId) => `import_mapping:${accountId}`;
const cents = (n) => Math.round(parseFloat(n) * 100);

// Accounts a CSV can be imported into: Primary Checking and active credit cards
const listImportAccounts = async () => {
  const checking = await getPrimaryCheckingAccount();
  const cards = await Account.findAll({
    where: { type: "CREDIT_CARD", isActive: { [Op.ne]: false } },
    order: [["name", "ASC"]],
  });
  const accounts = [checking, ...cards];
  const saved = await Setting.findAll({
    where: { key: { [Op.in]: accounts.map((a) => mappingKey(a.id)) } },
  });
  const savedKeys = new Set(saved.map((s) => s.key));
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    hasSavedMapping: savedKeys.has(mappingKey(a.id)),
  }));
};

// The account an import goes into, or a 400 when it can't take one
const getImportAccount = async (accountId, dbTx = null) => {
  const account = await Account.findByPk(accountId, { transaction: dbTx });
  if (!account || account.isActive === false) {
    throw new HttpError(400, "Pick an active checking account or credit card to import into.");
  }
  if (account.type === "CHECKING") {
    const primary = await getPrimaryCheckingAccount(dbTx);
    if (primary.id !== account.id) {
      throw new HttpError(400, "Imports into checking go to Primary Checking.");
    }
  } else if (account.type !== "CREDIT_CARD") {
    throw new HttpError(400, "CSV import works for checking and credit cards only.");
  }
  return account;
};

const getSavedMapping = async (accountId) => {
  const record = await Setting.findByPk(mappingKey(accountId));
  if (!record) return null;
  try {
    return JSON.parse(record.value);
  } catch {
    return null;
  }
};

const saveMapping = (accountId, mapping, dbTx = null) =>
  Setting.upsert({ key: mappingKey(accountId), value: JSON.stringify(mapping) }, { transaction: dbTx });

// The amount a bill will be once paid: a tax-exclusive bill is stored before tax until it's paid
const payableCents = (trx) => {
  const rate = trx.taxRate !== null && trx.taxRate !== undefined ? parseFloat(trx.taxRate) : 0;
  if (trx.isTaxExclusive && !trx.taxApplied && rate > 0) {
    return Math.round(parseFloat(trx.baseAmount ?? trx.amount) * (1 + rate / 100) * 100);
  }
  return cents(trx.amount);
};

// Can this unpaid row be the bank row? Money out pays a bill charged to this account (or to no card
// yet: an EXPENSE from checking that the card statement shows was paid by card) or a payment from
// this checking account. Money in on checking is an unpaid paycheque; on a card it's a scheduled
// payment to this card, which needs no similar title (the card statement just says "PAYMENT").
const isEligible = (candidate, row, account) => {
  if (row.direction === "out") {
    if (candidate.type === "EXPENSE" && !candidate.toAccountId) {
      const from = candidate.fromAccount;
      return !from || from.id === account.id || from.type === "CHECKING";
    }
    return (
      account.type === "CHECKING" &&
      ["EXPENSE", "TRANSFER"].includes(candidate.type) &&
      candidate.fromAccountId === account.id
    );
  }
  if (account.type === "CHECKING") return candidate.type === "INCOME";
  return candidate.type === "TRANSFER" && candidate.toAccountId === account.id;
};

// A chequing debit that pays a card: says payment and names the card ("TD VISA PAYMENT")
const PAYMENT_WORDS = /payment|pymt|pmt|paiement/i;
const CARD_WORDS = /visa|master ?card|amex|american express|credit card/i;
const looksLikePaymentTo = (description, card) =>
  PAYMENT_WORDS.test(description) && (titlesSimilar(card.name, description) || CARD_WORDS.test(description));

// The one active card a chequing debit pays, or null when it names none or can't tell them apart.
// "TD VISA PAYMENT" is similar to both "TD Visa" and "CIBC Visa"; the bank's own word ("td") decides.
const NOT_A_BANK_WORD = /^(visa|master|mastercard|amex|american|express|credit|card|payment|pymt|pmt|paiement|thank|you)$/;
const bankWords = (s) =>
  String(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !NOT_A_BANK_WORD.test(w));
const cardPaidBy = (description, cards) => {
  if (!PAYMENT_WORDS.test(description)) return null;
  const named = cards.filter((c) => titlesSimilar(c.name, description));
  if (named.length <= 1) return named[0] || null;
  const words = new Set(bankWords(description));
  const scored = named.map((c) => ({ c, score: bankWords(c.name).filter((w) => words.has(w)).length }));
  const top = Math.max(...scored.map((x) => x.score));
  const best = scored.filter((x) => x.score === top);
  return top > 0 && best.length === 1 ? best[0].c : null;
};

// A card payment shows on both statements: leaving chequing and reaching the card. Once one side is
// in the app (imported, entered by hand, or a scheduled payment marked paid), the other side links to
// that same TRANSFER instead of recording the payment again:
// - card money in: a paid TRANSFER from chequing to this card -> nothing to change ("link")
// - chequing money out: a paid TRANSFER from this chequing account to a card -> nothing to change,
//   or one the card import recorded with no from-account -> it gets this account as its from-account
// A TRANSFER links to each account's statement once (ImportRefs record which account linked it).
// A chequing row that names one card (payee) links only to transfers into that card; one that names
// none links only when every matching transfer goes to the same card.
const linkCandidateFor = (row, account, transfers, linkedBy, used, payee) => {
  const amountCents = cents(row.amount);
  let best = null;
  const cardsSeen = new Set();
  for (const t of transfers) {
    if (used.has(t.id) || cents(t.amount) !== amountCents) continue;
    if (linkedBy.get(t.id)?.has(account.id)) continue;
    const gap = daysBetween(t.date, row.date);
    if (gap > MATCH_WINDOW_DAYS) continue;
    let setFrom = false;
    if (account.type === "CREDIT_CARD") {
      if (row.direction !== "in" || t.toAccountId !== account.id || !t.fromAccountId) continue;
    } else {
      if (row.direction !== "out" || !t.toAccount) continue;
      if (payee ? t.toAccountId !== payee.id : !looksLikePaymentTo(row.description, t.toAccount)) continue;
      if (t.fromAccountId === account.id) setFrom = false;
      else if (!t.fromAccountId && t.category === "Credit Card Payment") setFrom = true;
      else continue;
      cardsSeen.add(t.toAccountId);
    }
    if (!best || gap < best.gap) best = { t, gap, setFrom };
  }
  return cardsSeen.size > 1 ? null : best;
};

const needsSimilarTitle = (candidate, row, account) =>
  !(row.direction === "in" && account.type === "CREDIT_CARD");

// Category for a new row: rules first, then the category the same title had before, else Other.
// Money in is Income on checking; on a card it's a payment or a refund (neither is spending).
const categoryFor = (row, account, rules, history) => {
  if (row.direction === "in") {
    return { category: account.type === "CHECKING" ? "Income" : "Credit Card Payment", ruleId: null };
  }
  const ruled = applyRules(rules, row.description);
  if (ruled.category) return { category: ruled.category, ruleId: ruled.categoryRuleId };
  const fromHistory =
    history.get(row.description.toLowerCase()) || history.get(normalizeMerchantName(row.description));
  return { category: fromHistory || "Other", ruleId: null };
};

// Money back from a store. On a card it's any credit that isn't a payment; on checking the bank says so.
// It is saved as negative spending (an EXPENSE with a negative amount), so it lowers that category's
// spending and the balance the same way the purchase raised them.
const CARD_PAYMENT_WORDS = /payment|paiement|thank you|merci/i;
const REFUND_WORDS = /refund|return|reversal|rembours|credit voucher/i;
const isRefund = (row, account) =>
  row.direction === "in" &&
  (account.type === "CREDIT_CARD" ? !CARD_PAYMENT_WORDS.test(row.description) : REFUND_WORDS.test(row.description));

// A refund takes the category of the purchase it gives back: the newest earlier purchase on this
// account with a similar title and at least the refunded amount (already in the app, or earlier in
// the same file). Then the rules; else "Refund", which counts as negative spending on its own.
const refundCategoryFor = (row, purchases, rules) => {
  const bought = purchases
    .filter(
      (p) =>
        p.date <= row.date &&
        daysBetween(p.date, row.date) <= REFUND_LOOKBACK_DAYS &&
        cents(p.amount) >= cents(row.amount) &&
        EXPENSE_CATEGORIES.includes(p.category) &&
        titlesSimilar(p.title, row.description)
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (bought) return { category: bought.category, ruleId: null, refundOf: { title: bought.title, date: bought.date } };
  const ruled = applyRules(rules, row.description);
  if (ruled.category) return { category: ruled.category, ruleId: ruled.categoryRuleId };
  return { category: "Refund", ruleId: null };
};
const REFUND_LOOKBACK_DAYS = 120;

// Categories the same titles had before (the newest wins), keyed by lower-case and normalized title
const loadCategoryHistory = async (dbTx) => {
  const past = await Transaction.findAll({
    attributes: ["title", "category"],
    where: { type: "EXPENSE", category: { [Op.in]: EXPENSE_CATEGORIES.filter((c) => c !== "Other") } },
    order: [["createdAt", "DESC"]],
    limit: 5000,
    transaction: dbTx,
  });
  const history = new Map();
  for (const t of past) {
    const lower = (t.title || "").toLowerCase();
    if (!history.has(lower)) history.set(lower, t.category);
    const norm = normalizeMerchantName(t.title || "");
    if (norm && !history.has(norm)) history.set(norm, t.category);
  }
  return history;
};

// Marks each parsed row (from applyMapping + withOccurrences) as
// - duplicate: its clientRef was already imported (a row or its Trash copy, or a matched bill) -> skipped
// - match: an unpaid row with the same amount, a date within 3 days and a similar title -> marked paid,
//   or the other statement's side of a card payment already in the app -> linked (linkCandidateFor)
// - new: created, with the category from the rules
// Each unpaid row matches at most one bank row, the closest by date.
const buildPreview = async (account, rows, dbTx = null) => {
  const refs = rows.map((r) => importClientRef(account.id, r.date, r.amount, r.description, r.occurrence));
  const [refRows, matchedRefs] = await Promise.all([
    Transaction.findAll({
      attributes: ["id", "clientRef", "deletedAt"],
      where: { clientRef: { [Op.in]: refs } },
      paranoid: false,
      transaction: dbTx,
    }),
    ImportRef.findAll({ where: { ref: { [Op.in]: refs } }, transaction: dbTx }),
  ]);
  const imported = new Map();
  for (const t of refRows) imported.set(t.clientRef, { id: t.id, inTrash: Boolean(t.deletedAt) });
  for (const r of matchedRefs) if (!imported.has(r.ref)) imported.set(r.ref, { id: r.transactionId, inTrash: false });

  const dates = rows.map((r) => r.date).sort();
  const shift = (ymd, days) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const candidates = await Transaction.findAll({
    where: {
      isCleared: false,
      date: { [Op.between]: [shift(dates[0], -MATCH_WINDOW_DAYS), shift(dates[dates.length - 1], MATCH_WINDOW_DAYS)] },
    },
    include: [
      { model: Account, as: "fromAccount" },
      { model: Account, as: "toAccount" },
    ],
    order: [["date", "ASC"]],
    transaction: dbTx,
  });
  // Paid card payments in the same window, for linking the other statement's side of a payment
  const transfers = await Transaction.findAll({
    where: {
      type: "TRANSFER",
      isCleared: true,
      toAccountId: { [Op.ne]: null },
      date: { [Op.between]: [shift(dates[0], -MATCH_WINDOW_DAYS), shift(dates[dates.length - 1], MATCH_WINDOW_DAYS)] },
    },
    include: [{ model: Account, as: "toAccount", where: { type: { [Op.in]: ["CREDIT_CARD", "DEBT"] } } }],
    order: [["date", "ASC"]],
    transaction: dbTx,
  });
  const linkRefs = transfers.length
    ? await ImportRef.findAll({
        where: { transactionId: { [Op.in]: transfers.map((t) => t.id) } },
        transaction: dbTx,
      })
    : [];
  const linkedBy = new Map();
  for (const r of linkRefs) {
    if (!linkedBy.has(r.transactionId)) linkedBy.set(r.transactionId, new Set());
    linkedBy.get(r.transactionId).add(r.accountId);
  }
  const cards =
    account.type === "CHECKING"
      ? await Account.findAll({
          where: { type: { [Op.in]: ["CREDIT_CARD", "DEBT"] }, isActive: { [Op.ne]: false } },
          transaction: dbTx,
        })
      : [];
  const rules = await loadRules(dbTx);
  const history = await loadCategoryHistory(dbTx);
  const used = new Set();
  // Earlier purchases on this account, for the category of a refund
  const purchases = (
    await Transaction.findAll({
      attributes: ["title", "date", "amount", "category"],
      where: {
        type: "EXPENSE",
        isCleared: true,
        fromAccountId: account.id,
        amount: { [Op.gt]: 0 },
        date: { [Op.between]: [shift(dates[0], -REFUND_LOOKBACK_DAYS), dates[dates.length - 1]] },
      },
      transaction: dbTx,
      raw: true,
    })
  ).map((p) => ({ ...p, amount: parseFloat(p.amount) }));
  // Rows dated on or before the last time the balance was set or synced are history: the balance
  // already includes them, so importing them changes no balance
  const anchorDate = await getBalanceAnchor(account, dbTx);

  const out = rows.map((row, i) => {
    const ref = refs[i];
    const base = {
      line: row.line,
      date: row.date,
      description: row.description,
      amount: row.amount,
      direction: row.direction,
      occurrence: row.occurrence,
      clientRef: ref,
    };
    // A chequing debit that pays one of your cards is a TRANSFER to it, not spending
    const payee = account.type === "CHECKING" && row.direction === "out" ? cardPaidBy(row.description, cards) : null;
    if (payee) base.toCard = { id: payee.id, name: payee.name, type: payee.type };
    const refund = isRefund(row, account);
    if (refund) base.refund = true;
    const prior = imported.get(ref);
    if (prior) {
      return { ...base, status: "duplicate", existingId: prior.id, inTrash: prior.inTrash, category: null };
    }
    const amountCents = cents(row.amount);
    let best = null;
    for (const c of candidates) {
      if (used.has(c.id) || payableCents(c) !== amountCents) continue;
      const gap = daysBetween(c.date, row.date);
      if (gap > MATCH_WINDOW_DAYS || !isEligible(c, row, account)) continue;
      // A refund isn't a payment: it never pays a scheduled card payment
      if (refund && c.type === "TRANSFER") continue;
      // A row that names one card never pays a scheduled payment to another card
      if (payee && c.type === "TRANSFER" && c.toAccountId && c.toAccountId !== payee.id) continue;
      if (needsSimilarTitle(c, row, account) && !titlesSimilar(c.title, row.description)) continue;
      if (!best || gap < best.gap) best = { c, gap };
    }
    if (best) {
      used.add(best.c.id);
      return {
        ...base,
        status: "match",
        category: best.c.category,
        match: {
          id: best.c.id,
          title: best.c.title,
          date: best.c.date,
          amount: parseFloat(best.c.amount),
          category: best.c.category,
        },
      };
    }
    const link = refund ? null : linkCandidateFor(row, account, transfers, linkedBy, used, payee);
    if (link) {
      used.add(link.t.id);
      return {
        ...base,
        status: "match",
        category: link.t.category,
        match: {
          id: link.t.id,
          title: link.t.title,
          date: link.t.date,
          amount: parseFloat(link.t.amount),
          category: link.t.category,
          alreadyRecorded: true,
          setFrom: link.setFrom,
        },
      };
    }
    if (payee) {
      return { ...base, status: "new", category: payee.type === "DEBT" ? "Debt" : "Credit Card Payment", ruleId: null };
    }
    if (refund) return { ...base, status: "new", ...refundCategoryFor(row, purchases, rules) };
    const { category, ruleId } = categoryFor(row, account, rules, history);
    // A later refund in the same file takes this purchase's category
    if (row.direction === "out") purchases.push({ title: row.description, date: row.date, amount: row.amount, category });
    return { ...base, status: "new", category, ruleId };
  }).map((row) => withBalanceEffect(row, account, anchorDate));

  const counts = {
    matched: out.filter((r) => r.status === "match").length,
    new: out.filter((r) => r.status === "new").length,
    skipped: out.filter((r) => r.status === "duplicate").length,
    history: out.filter((r) => r.history).length,
    balanceChanging: out.filter((r) => r.balanceEffect !== 0).length,
  };
  const balanceNow = await getAppBalance(account, dbTx);
  const balanceAfter = Math.round((balanceNow + out.reduce((sum, r) => sum + r.balanceEffect, 0)) * 100) / 100;
  return { rows: out, counts, anchorDate, balanceNow, balanceAfter };
};

// What importing a row does to this account's balance (owed on a card): history rows and links to a
// payment the other statement already recorded change nothing; the client sums the rows it keeps.
const withBalanceEffect = (row, account, anchorDate) => {
  if (row.status === "duplicate") return { ...row, history: false, balanceEffect: 0 };
  const history = Boolean(anchorDate && row.date <= anchorDate);
  const linkedOnly = row.status === "match" && row.match.alreadyRecorded && !row.match.setFrom;
  const raises = account.type === "CHECKING" ? row.direction === "in" : row.direction === "out";
  const effect = history || linkedOnly ? 0 : raises ? row.amount : -row.amount;
  return { ...row, history, balanceEffect: Math.round(effect * 100) / 100 };
};

// Applies an import in one database transaction. The rows are the preview's rows as the client
// edited them; the server re-runs the preview so a row imported or a bill paid since then is not
// counted twice. Client edits honoured: skip, category (new money-out rows), and matchId: null to
// import a matched row as new instead.
const commitImport = async ({ accountId, rows, mapping }) => {
  const dbTx = await sequelize.transaction();
  try {
    const account = await getImportAccount(accountId, dbTx);
    const checking = await getPrimaryCheckingAccount(dbTx);
    const archivedBefore = await snapshotArchivedBalances(dbTx);
    const { rows: preview } = await buildPreview(account, rows, dbTx);
    const result = { created: 0, matched: 0, skipped: 0, history: 0, ids: [], matchedIds: [] };
    // Which sides of a row the balances already include: Checking's side by Checking's anchor, the
    // card's or debt's side by its own (a card payment touches both)
    const anchors = new Map();
    const anchorOf = async (id) => {
      if (!anchors.has(id)) {
        const acc = await Account.findByPk(id, { transaction: dbTx });
        anchors.set(id, acc ? await getBalanceAnchor(acc, dbTx) : null);
      }
      return anchors.get(id);
    };
    const sidesFor = async (trx, date) => {
      const storedId = [trx.toAccountId, trx.fromAccountId].find((id) => id && id !== checking.id);
      const checkingAnchor = await anchorOf(checking.id);
      const storedAnchor = storedId ? await anchorOf(storedId) : null;
      return {
        checkingHistory: Boolean(checkingAnchor && date <= checkingAnchor),
        storedHistory: Boolean(storedAnchor && date <= storedAnchor),
      };
    };

    for (let i = 0; i < preview.length; i++) {
      const row = preview[i];
      const sent = rows[i];
      if (sent.skip || row.status === "duplicate") {
        result.skipped++;
        continue;
      }
      if (row.status === "match" && sent.matchId !== null && row.match.alreadyRecorded) {
        // The other statement already recorded this payment: link to it, change no balance unless
        // the card side had no from-account yet (then it now comes out of this chequing account)
        if (row.match.setFrom) {
          const transfer = await Transaction.findByPk(row.match.id, { transaction: dbTx });
          // The card statement already applied (or recorded as history) the card's side; this
          // adds Checking's side, unless Checking's balance already includes it
          const before = checkingEffect(transfer, checking.id);
          await transfer.update({ fromAccountId: account.id }, { transaction: dbTx });
          await applyImportedRow(transfer, checking.id, await sidesFor(transfer, row.date), dbTx, before);
        }
        await ImportRef.create(
          { ref: row.clientRef, transactionId: row.match.id, accountId: account.id },
          { transaction: dbTx }
        );
        result.matched++;
        if (row.history) result.history++;
        result.matchedIds.push(row.match.id);
        continue;
      }
      if (row.status === "match" && sent.matchId !== null) {
        const bill = await Transaction.findByPk(row.match.id, { transaction: dbTx });
        // Reverse, change, re-apply: the same path as marking a bill paid in the edit form
        await adjustAccountForTransaction(bill, -1, dbTx);
        const changes = { isCleared: true, amount: row.amount };
        if (bill.isTaxExclusive && parseFloat(bill.taxRate) > 0) changes.taxApplied = true;
        if (bill.type === "EXPENSE" && !bill.toAccountId) changes.fromAccountId = account.id;
        await bill.update(changes, { transaction: dbTx });
        await applyImportedRow(bill, checking.id, await sidesFor(bill, row.date), dbTx);
        await ImportRef.create(
          { ref: row.clientRef, transactionId: bill.id, accountId: account.id },
          { transaction: dbTx }
        );
        result.matched++;
        if (row.history) result.history++;
        result.matchedIds.push(bill.id);
        continue;
      }

      let fields;
      let amount = row.amount;
      if (row.toCard) {
        const category = row.toCard.type === "DEBT" ? "Debt" : "Credit Card Payment";
        fields = { type: "TRANSFER", category, fromAccountId: account.id, toAccountId: row.toCard.id };
      } else if (row.refund) {
        // Negative spending: lowers the category's spending and moves the balance back
        const wanted =
          sent.category && (EXPENSE_CATEGORIES.includes(sent.category) || sent.category === "Refund") ? sent.category : null;
        fields = { type: "EXPENSE", category: wanted || row.category, fromAccountId: account.id, toAccountId: null };
        amount = -row.amount;
      } else if (row.direction === "out") {
        const wanted = sent.category && EXPENSE_CATEGORIES.includes(sent.category) ? sent.category : null;
        const category = wanted || (row.status === "new" ? row.category : null) || "Other";
        fields = { type: "EXPENSE", category, fromAccountId: account.id, toAccountId: null };
      } else if (account.type === "CHECKING") {
        fields = { type: "INCOME", category: "Income", fromAccountId: null, toAccountId: account.id };
      } else {
        // A payment on the card lowers what's owed; like a statement-sync Adjustment it has no
        // from-account, so it doesn't count as spending, income or a checking withdrawal
        fields = { type: "TRANSFER", category: "Credit Card Payment", fromAccountId: null, toAccountId: account.id };
      }
      const created = await Transaction.create(
        {
          ...fields,
          title: row.description,
          amount,
          date: row.date,
          isCleared: true,
          recurrence: "none",
          clientRef: row.clientRef,
          needsReview: true,
        },
        { transaction: dbTx }
      );
      // The bank says it happened, so it changes balances whatever its date, except on a side whose
      // account's balance was set or synced on or after it (history)
      await applyImportedRow(created, checking.id, await sidesFor(created, row.date), dbTx);
      // Records which account's statement holds this row, so the other side of a card payment can link
      await ImportRef.create(
        { ref: row.clientRef, transactionId: created.id, accountId: account.id },
        { transaction: dbTx }
      );
      result.created++;
      if (row.history) result.history++;
      result.ids.push(created.id);
    }

    await assertArchivedBalancesUnchanged(archivedBefore, dbTx);
    if (mapping) await saveMapping(account.id, mapping, dbTx);
    await account.reload({ transaction: dbTx });
    result.balance = await getAppBalance(account, dbTx);
    await dbTx.commit();
    return result;
  } catch (error) {
    if (!dbTx.finished) await dbTx.rollback();
    throw error;
  }
};

module.exports = {
  listImportAccounts,
  getImportAccount,
  getSavedMapping,
  saveMapping,
  buildPreview,
  commitImport,
  MATCH_WINDOW_DAYS,
};
