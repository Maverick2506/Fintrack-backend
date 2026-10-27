const { Op } = require("sequelize");
const { sequelize, Account, Transaction, Setting, ImportRef } = require("../models");
const { EXPENSE_CATEGORIES } = require("../constants/categories");
const { adjustAccountForTransaction } = require("./accountBalanceService");
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

const needsSimilarTitle = (candidate, row, account) =>
  !(row.direction === "in" && account.type === "CREDIT_CARD");

// Category for a new row: rules first, then the category the same title had before, else Other.
// Money in is Income on checking; on a card it's a payment or a refund (neither is spending).
const categoryFor = (row, account, rules, history) => {
  if (row.direction === "in") {
    if (account.type === "CHECKING") return { category: "Income", ruleId: null };
    return {
      category: /payment|paiement|thank you|merci/i.test(row.description) ? "Credit Card Payment" : "Refund",
      ruleId: null,
    };
  }
  const ruled = applyRules(rules, row.description);
  if (ruled.category) return { category: ruled.category, ruleId: ruled.categoryRuleId };
  const fromHistory =
    history.get(row.description.toLowerCase()) || history.get(normalizeMerchantName(row.description));
  return { category: fromHistory || "Other", ruleId: null };
};

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
// - match: an unpaid row with the same amount, a date within 3 days and a similar title -> marked paid
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
  const rules = await loadRules(dbTx);
  const history = await loadCategoryHistory(dbTx);
  const used = new Set();

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
    const { category, ruleId } = categoryFor(row, account, rules, history);
    return { ...base, status: "new", category, ruleId };
  });

  const counts = {
    matched: out.filter((r) => r.status === "match").length,
    new: out.filter((r) => r.status === "new").length,
    skipped: out.filter((r) => r.status === "duplicate").length,
  };
  return { rows: out, counts };
};

// Applies an import in one database transaction. The rows are the preview's rows as the client
// edited them; the server re-runs the preview so a row imported or a bill paid since then is not
// counted twice. Client edits honoured: skip, category (new money-out rows), and matchId: null to
// import a matched row as new instead.
const commitImport = async ({ accountId, rows, mapping }) => {
  const dbTx = await sequelize.transaction();
  try {
    const account = await getImportAccount(accountId, dbTx);
    const archivedBefore = await snapshotArchivedBalances(dbTx);
    const { rows: preview } = await buildPreview(account, rows, dbTx);
    const result = { created: 0, matched: 0, skipped: 0, ids: [], matchedIds: [] };

    for (let i = 0; i < preview.length; i++) {
      const row = preview[i];
      const sent = rows[i];
      if (sent.skip || row.status === "duplicate") {
        result.skipped++;
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
        await adjustAccountForTransaction(bill, 1, dbTx, true);
        await ImportRef.create(
          { ref: row.clientRef, transactionId: bill.id, accountId: account.id },
          { transaction: dbTx }
        );
        result.matched++;
        result.matchedIds.push(bill.id);
        continue;
      }

      let fields;
      if (row.direction === "out") {
        const wanted = sent.category && EXPENSE_CATEGORIES.includes(sent.category) ? sent.category : null;
        const category = wanted || (row.status === "new" ? row.category : null) || "Other";
        fields = { type: "EXPENSE", category, fromAccountId: account.id, toAccountId: null };
      } else if (account.type === "CHECKING") {
        fields = { type: "INCOME", category: "Income", fromAccountId: null, toAccountId: account.id };
      } else {
        // A payment or refund on the card lowers what's owed; like a statement-sync Adjustment it
        // has no from-account, so it doesn't count as spending, income or a checking withdrawal
        const category =
          row.status === "new"
            ? row.category
            : /payment|paiement|thank you|merci/i.test(row.description)
            ? "Credit Card Payment"
            : "Refund";
        fields = { type: "TRANSFER", category, fromAccountId: null, toAccountId: account.id };
      }
      const created = await Transaction.create(
        {
          ...fields,
          title: row.description,
          amount: row.amount,
          date: row.date,
          isCleared: true,
          recurrence: "none",
          clientRef: row.clientRef,
          needsReview: true,
        },
        { transaction: dbTx }
      );
      // The bank says it happened, so it changes the balance whatever its date
      await adjustAccountForTransaction(created, 1, dbTx, true);
      result.created++;
      result.ids.push(created.id);
    }

    await assertArchivedBalancesUnchanged(archivedBefore, dbTx);
    if (mapping) await saveMapping(account.id, mapping, dbTx);
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
