const { Op } = require("sequelize");
const { Account, Transaction, Setting } = require("../models");
const { HttpError } = require("../middleware/errorHandler");
const { adjustAccountForTransaction } = require("./accountBalanceService");
const { getPrimaryCheckingAccount } = require("./checkingService");
const { getStatementDate, getNextStatementDate } = require("./statementService");
const {
  getNextOccurrenceDate,
  getSeriesTemplate,
  groupSeries,
  ACTIVE_RECURRENCES,
} = require("../routes/recurring");

// Sinking funds: a savings goal linked to a bill (an expense series) saves for that bill's next
// charge. The goal's own target amount and date win; without them the bill's amount and next date
// are used. The monthly amount is what Safe to Spend sets aside (forecastService).

const round2 = (n) => Math.round(n * 100) / 100;

// Safe to Spend's window (the Dashboard forecast is 60 days, today included)
const FORECAST_WINDOW_DAYS = 60;
const addDays = (dateStr, days) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
};

const firstOfNextMonth = (todayStr) => {
  const [y, m] = todayStr.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

/**
 * Monthly amount to have `target` saved by `dueDate`. Contributions are monthly: today, or the 1st of
 * next month when the goal already got (or has scheduled) a contribution this month, and then the same
 * day each month, up to and including the due date. A due date that leaves no such day (it has passed,
 * or it is this month after this month's contribution) needs the rest now: one contribution today.
 * Rounded up to the cent, so the contributions always reach the target.
 */
const computeSinkingFund = ({ current, target, dueDate, todayStr, contributedThisMonth = false }) => {
  const targetNum = parseFloat(target) || 0;
  if (!dueDate || targetNum <= 0) return null;
  const remaining = round2(Math.max(0, targetNum - (parseFloat(current) || 0)));
  if (remaining <= 0) {
    return { target: targetNum, dueDate, remaining: 0, monthly: 0, dates: [], ready: true, overdue: false };
  }

  const start = contributedThisMonth ? firstOfNextMonth(todayStr) : todayStr;
  const dates = [];
  for (let k = 0; k < 600; k++) {
    const d = k === 0 ? start : getNextOccurrenceDate(start, "monthly", k);
    if (!d || d > dueDate) break;
    dates.push(d);
  }
  if (dates.length === 0) dates.push(todayStr);

  return {
    target: targetNum,
    dueDate,
    remaining,
    monthly: Math.ceil(Math.round(remaining * 100) / dates.length) / 100,
    dates,
    ready: false,
    overdue: dueDate < todayStr,
  };
};

/**
 * The bill a goal is linked to: its title, recurrence and next charge (the first unpaid row dated
 * today or later, else the next date the series will generate). `ended` when the series has no
 * recurring row left (cancelled); null when no row of the series exists.
 */
const getLinkedBill = (rowsNewestFirst, todayStr) => {
  if (!rowsNewestFirst || rowsNewestFirst.length === 0) return null;
  const series = getSeriesTemplate(rowsNewestFirst);
  const newest = rowsNewestFirst[0];
  const base = {
    recurringGroupId: newest.recurringGroupId,
    title: (series ? series.template : newest).title,
  };
  if (!series) {
    // A one-off bill (or a series that was ended): its next charge is its earliest unpaid row, if any
    const unpaid = rowsNewestFirst
      .filter((r) => !r.isCleared)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return {
      ...base,
      title: (unpaid || newest).title,
      ended: !unpaid,
      oneOff: true,
      recurrence: "none",
      amount: unpaid ? round2(parseFloat(unpaid.amount) || 0) : null,
      nextDate: unpaid ? unpaid.date : null,
      fromChecking: unpaid ? !unpaid.fromAccount || unpaid.fromAccount.type === "CHECKING" : false,
      cardId: unpaid?.fromAccount?.type === "CREDIT_CARD" ? unpaid.fromAccountId : null,
    };
  }

  const { template, newestDate, anchorDay } = series;
  const unpaid = rowsNewestFirst
    .filter((r) => !r.isCleared && r.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  let nextDate = unpaid ? unpaid.date : null;
  let amount = unpaid ? parseFloat(unpaid.amount) : parseFloat(template.amount);
  if (!nextDate) {
    for (let step = 1; step < 2000; step++) {
      const d = getNextOccurrenceDate(template.date, template.recurrence, step, anchorDay);
      if (!d) break;
      if (d > newestDate && d >= todayStr) {
        nextDate = d;
        break;
      }
    }
    amount = parseFloat(template.amount);
  }
  return {
    ...base,
    ended: false,
    oneOff: false,
    recurrence: template.recurrence,
    amount: round2(amount || 0),
    nextDate,
    // Charged to Checking (not a card): the forecast counts it on its date
    fromChecking: !template.fromAccount || template.fromAccount.type === "CHECKING",
    // Charged to a card: the fund pays when the card is paid (settleCardFundBills)
    cardId: template.fromAccount?.type === "CREDIT_CARD" ? template.fromAccountId : null,
  };
};

/**
 * Sinking fund details for the given goals (default: every active goal with a linked bill), keyed by
 * goal id: { linkedBill, target, dueDate, remaining, monthly, dates, ready, overdue, monthlyTransfer }.
 * monthlyTransfer is the goal's running contribution series, or the transfers "Set up monthly transfer"
 * scheduled ({ recurringGroupId, amount, recurrence, until, count }),
 * or null. Safe to Spend plans `monthly` only when there is no such series (the series is projected).
 */
const getSinkingFunds = async (todayStr, dbTx = null, goals = null) => {
  const linkedGoals = (
    goals ||
    (await Account.findAll({
      where: {
        type: "SAVINGS_GOAL",
        isActive: { [Op.ne]: false },
        linkedRecurringGroupId: { [Op.ne]: null },
      },
      order: [["createdAt", "ASC"]],
      transaction: dbTx,
    }))
  ).filter((g) => g.linkedRecurringGroupId);
  const result = new Map();
  if (linkedGoals.length === 0) return result;

  const groupIds = [...new Set(linkedGoals.map((g) => g.linkedRecurringGroupId))];
  const goalIds = linkedGoals.map((g) => g.id);
  const [billRows, goalRows] = await Promise.all([
    Transaction.findAll({
      where: { recurringGroupId: { [Op.in]: groupIds } },
      include: [{ model: Account, as: "fromAccount" }],
      order: [["date", "DESC"], ["createdAt", "DESC"]],
      transaction: dbTx,
    }),
    Transaction.findAll({
      where: { toAccountId: { [Op.in]: goalIds } },
      order: [["date", "DESC"], ["createdAt", "DESC"]],
      transaction: dbTx,
    }),
  ]);

  const billRowsBySeries = new Map();
  for (const r of billRows) {
    if (!billRowsBySeries.has(r.recurringGroupId)) billRowsBySeries.set(r.recurringGroupId, []);
    billRowsBySeries.get(r.recurringGroupId).push(r);
  }
  const monthStart = `${todayStr.slice(0, 7)}-01`;
  const monthEnd = `${todayStr.slice(0, 7)}-31`;
  const goalSeries = groupSeries(goalRows.filter((r) => r.recurringGroupId || ACTIVE_RECURRENCES.includes(r.recurrence)));

  for (const goal of linkedGoals) {
    const bill = getLinkedBill(billRowsBySeries.get(goal.linkedRecurringGroupId) || [], todayStr);
    const ownTarget = parseFloat(goal.targetAmount) || 0;
    const target = ownTarget > 0 ? ownTarget : bill?.amount || 0;
    const dueDate = goal.dueDate || bill?.nextDate || null;
    // Any contribution dated this month, paid or scheduled. A scheduled one counts as saved, so the
    // monthly amount doesn't jump when this month's transfer is set up but not yet made.
    const thisMonth = goalRows.filter(
      (r) => r.toAccountId === goal.id && r.date >= monthStart && r.date <= monthEnd
    );
    const contributedThisMonth = thisMonth.length > 0;
    const scheduledThisMonth = thisMonth
      .filter((r) => !r.isCleared)
      .reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const running = Object.values(goalSeries.seriesTemplates)
      .map((s) => s.template)
      .filter((t) => t.toAccountId === goal.id)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    // "Set up monthly transfer" schedules one transfer per contribution date (it ends on its own)
    const scheduled = goalRows
      .filter((r) => r.toAccountId === goal.id && !r.isCleared && r.date >= monthStart)
      .sort((a, b) => a.date.localeCompare(b.date));

    // A bill that ends with its last payment (a one-off, or a series that was ended) and has been paid:
    // the fund is done. A recurring bill rolls the fund on to its next charge instead (paySinkingFundBill).
    const seriesRows = billRowsBySeries.get(goal.linkedRecurringGroupId) || [];
    const lastPaid = seriesRows.find((r) => r.isCleared);
    const done = Boolean(bill && lastPaid && (bill.ended || !bill.nextDate) && !seriesRows.some((r) => !r.isCleared));
    if (done) {
      result.set(goal.id, {
        name: goal.name,
        linkedBill: bill,
        saved: round2(parseFloat(goal.initialBalance) || 0),
        target,
        dueDate: goal.dueDate || lastPaid.date,
        remaining: 0,
        monthly: 0,
        dates: [],
        ready: false,
        overdue: false,
        done: true,
        paidOn: lastPaid.date,
        billInForecast: false,
        monthlyTransfer: null,
      });
      continue;
    }

    const fund = computeSinkingFund({
      current: (parseFloat(goal.initialBalance) || 0) + scheduledThisMonth,
      target,
      dueDate,
      todayStr,
      contributedThisMonth,
    });
    result.set(goal.id, {
      name: goal.name,
      linkedBill: bill,
      saved: round2(parseFloat(goal.initialBalance) || 0),
      done: false,
      paidOn: null,
      ...(fund || { target, dueDate, remaining: null, monthly: null, dates: [], ready: false, overdue: false }),
      // The bill's next charge is already in Safe to Spend's window, so nothing more is set aside for it
      billInForecast: Boolean(
        bill?.nextDate && bill.fromChecking && dueDate && bill.nextDate <= dueDate &&
          bill.nextDate <= addDays(todayStr, FORECAST_WINDOW_DAYS - 1)
      ),
      monthlyTransfer: running
        ? {
            recurringGroupId: running.recurringGroupId || running.id,
            amount: round2(parseFloat(running.amount) || 0),
            recurrence: running.recurrence,
            until: null,
            count: null,
          }
        : scheduled.length > 0
        ? {
            recurringGroupId: scheduled[0].recurringGroupId,
            amount: round2(parseFloat(scheduled[0].amount) || 0),
            recurrence: "monthly",
            until: scheduled[scheduled.length - 1].date,
            count: scheduled.length,
          }
        : null,
    });
  }
  return result;
};

const loadBill = async (recurringGroupId, todayStr, dbTx = null) =>
  getLinkedBill(
    await Transaction.findAll({
      where: { recurringGroupId },
      include: [{ model: Account, as: "fromAccount" }],
      order: [["date", "DESC"], ["createdAt", "DESC"]],
      transaction: dbTx,
    }),
    todayStr
  );

// What a fund did for one paid bill, so un-marking the bill (or its card payment) can undo it:
// Setting fund_paid:<billId> = { goalId, transferId, amount, paymentId, rolledOver }.
// A card payment that paid bills from their funds: Setting fund_paid_by:<paymentId> = [billId, ...].
const FUND_PAID_PREFIX = "fund_paid:";
const FUND_PAID_BY_PREFIX = "fund_paid_by:";

const readJson = async (key, dbTx) => {
  const setting = await Setting.findByPk(key, { transaction: dbTx });
  if (!setting) return null;
  try {
    return JSON.parse(setting.value);
  } catch {
    return null;
  }
};
const writeJson = (key, value, dbTx) => Setting.upsert({ key, value: JSON.stringify(value) }, { transaction: dbTx });

/**
 * After a linked bill is paid, each goal saving for a recurring bill rolls over to its next charge:
 * a goal's own due date becomes the bill's next date and its own target the next bill's amount (a
 * goal without its own keeps following the bill). What is left in the goal stays; the monthly amount
 * is worked out again from it. A bill with no next charge leaves the goal Done (getSinkingFunds).
 * Returns [{ goalId, dueDate, targetAmount, previousDueDate, previousTargetAmount }] for the goals that
 * rolled over (the previous values are what un-marking the bill puts back).
 */
const rollOverLinkedFunds = async (recurringGroupId, todayStr, dbTx = null) => {
  if (!recurringGroupId) return [];
  const goals = await Account.findAll({
    where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false }, linkedRecurringGroupId: recurringGroupId },
    transaction: dbTx,
  });
  if (goals.length === 0) return [];
  const bill = await loadBill(recurringGroupId, todayStr, dbTx);
  if (!bill || bill.ended || bill.oneOff || !bill.nextDate) return [];
  const rolled = [];
  for (const goal of goals) {
    const previousDueDate = goal.dueDate || null;
    const previousTargetAmount = goal.targetAmount === null || goal.targetAmount === undefined ? null : parseFloat(goal.targetAmount);
    const updates = {};
    if (goal.dueDate) updates.dueDate = bill.nextDate;
    if (parseFloat(goal.targetAmount) > 0) updates.targetAmount = bill.amount;
    if (Object.keys(updates).length > 0) await goal.update(updates, { transaction: dbTx });
    rolled.push({ goalId: goal.id, dueDate: bill.nextDate, targetAmount: bill.amount, previousDueDate, previousTargetAmount });
  }
  return rolled;
};

// One cleared TRANSFER goal -> Checking for min(saved, bill), dated `date`. { amount, transfer }
const moveFromFund = async (goalId, billAmount, title, date, checking, dbTx) => {
  const goal = await Account.findByPk(goalId, { transaction: dbTx });
  const amount = round2(Math.max(0, Math.min(parseFloat(goal.initialBalance) || 0, billAmount)));
  if (amount <= 0) return { goal, amount: 0, transfer: null };
  const transfer = await Transaction.create(
    {
      title: `${title} paid from ${goal.name}`,
      amount,
      date,
      type: "TRANSFER",
      category: "Savings Transfer",
      isCleared: true,
      balanceApplied: false,
      recurrence: "none",
      fromAccountId: goal.id,
      toAccountId: checking.id,
    },
    { transaction: dbTx }
  );
  await adjustAccountForTransaction(transfer, 1, dbTx, true);
  return { goal, amount, transfer };
};

const isFromChecking = (bill, checking) => !bill.fromAccountId || bill.fromAccountId === checking.id;

/**
 * A bill linked to a sinking fund was just marked paid. With payFromGoalId (the "Pay from <fund>"
 * box), the fund pays what it can: one cleared TRANSFER fund -> Checking for min(saved, bill),
 * dated with the bill, so Checking ends where it was when the fund covers the bill; any shortfall is
 * paid by Checking. Then the funds roll over (rollOverLinkedFunds).
 * Only a bill paid from Primary Checking: a bill charged to a card is paid from its fund when the
 * card is paid (settleCardFundBills), so here it returns null and nothing moves or rolls over.
 * Returns { paidFromFund: { goalId, goalName, amount, shortfall, transferId } | null, rolledOver }.
 */
const payLinkedBill = async (bill, { payFromGoalId = null } = {}, todayStr, dbTx = null) => {
  const checking = await getPrimaryCheckingAccount(dbTx);
  if (!isFromChecking(bill, checking)) {
    if (payFromGoalId) {
      throw new HttpError(400, "A bill charged to a card is paid from its fund when you pay the card.");
    }
    return null;
  }
  let paidFromFund = null;
  if (payFromGoalId) {
    const goal = await Account.findByPk(payFromGoalId, { transaction: dbTx });
    if (
      !goal ||
      goal.type !== "SAVINGS_GOAL" ||
      goal.isActive === false ||
      !bill.recurringGroupId ||
      goal.linkedRecurringGroupId !== bill.recurringGroupId
    ) {
      throw new HttpError(400, "That goal isn't saving for this bill.");
    }
    const billAmount = round2(parseFloat(bill.amount) || 0);
    const { amount, transfer } = await moveFromFund(goal.id, billAmount, bill.title, bill.date, checking, dbTx);
    paidFromFund = {
      goalId: goal.id,
      goalName: goal.name,
      amount,
      shortfall: round2(billAmount - amount),
      transferId: transfer ? transfer.id : null,
    };
  }
  const rolledOver = await rollOverLinkedFunds(bill.recurringGroupId, todayStr, dbTx);
  if (paidFromFund?.transferId || rolledOver.length > 0) {
    await writeJson(
      `${FUND_PAID_PREFIX}${bill.id}`,
      {
        goalId: paidFromFund?.goalId || null,
        transferId: paidFromFund?.transferId || null,
        amount: paidFromFund?.amount || 0,
        paymentId: null,
        rolledOver,
      },
      dbTx
    );
  }
  return { paidFromFund, rolledOver };
};

/**
 * A bill cleared without anyone choosing (the nightly sweep clears unpaid bills on their date): it is
 * paid from the goal saving for it, the same default as the "Pay from <fund>" box, when that goal has
 * money in it; either way the goals roll over. Returns payLinkedBill's result, or null for a bill no
 * goal saves for, or one charged to a card (its fund pays when the card is paid).
 */
const payLinkedBillByDefault = async (bill, todayStr, dbTx = null) => {
  if (bill.type !== "EXPENSE" || !bill.recurringGroupId) return null;
  const goals = await Account.findAll({
    where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false }, linkedRecurringGroupId: bill.recurringGroupId },
    order: [["createdAt", "ASC"]],
    transaction: dbTx,
  });
  if (goals.length === 0) return null;
  const checking = await getPrimaryCheckingAccount(dbTx);
  if (!isFromChecking(bill, checking)) return null;
  const funded = goals.find((g) => (parseFloat(g.initialBalance) || 0) > 0);
  return payLinkedBill(bill, { payFromGoalId: funded ? funded.id : null }, todayStr, dbTx);
};

// A bill paid by the bank (a matched import row): nothing moves out of the goal, and a bill paid from
// Checking rolls its funds on to the next charge. A card charge waits for the card to be paid.
const rollOverForPaidBill = async (bill, todayStr, dbTx = null) => {
  if (bill.type !== "EXPENSE" || !bill.recurringGroupId) return [];
  const checking = await getPrimaryCheckingAccount(dbTx);
  if (!isFromChecking(bill, checking)) return [];
  const rolledOver = await rollOverLinkedFunds(bill.recurringGroupId, todayStr, dbTx);
  if (rolledOver.length > 0) {
    await writeJson(
      `${FUND_PAID_PREFIX}${bill.id}`,
      { goalId: null, transferId: null, amount: 0, paymentId: null, rolledOver },
      dbTx
    );
  }
  return rolledOver;
};

/**
 * The charges a card payment pays: for a card with a statement day, the charges on its last closed
 * statement (after the statement before it, up to the statement date); otherwise the charges since
 * the card's last paid payment (at most 62 days back), up to today. { from (exclusive), to }.
 */
const getCardBillWindow = async (card, todayStr, dbTx = null, excludePaymentId = null) => {
  const statementDay = parseInt(card.statementDay, 10);
  if (statementDay >= 1 && statementDay <= 31) {
    const to = getStatementDate(todayStr, statementDay);
    return { from: getStatementDate(addDays(to, -1), statementDay), to };
  }
  const lastPayment = await Transaction.findOne({
    where: {
      toAccountId: card.id,
      type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
      isCleared: true,
      date: { [Op.lt]: todayStr },
      ...(excludePaymentId ? { id: { [Op.ne]: excludePaymentId } } : {}),
    },
    order: [["date", "DESC"]],
    transaction: dbTx,
  });
  const floor = addDays(todayStr, -62);
  return { from: lastPayment && lastPayment.date > floor ? lastPayment.date : floor, to: todayStr };
};

// The statement date a card charge on dateStr is billed on (the first statement date on or after it)
const getChargeStatementDate = (dateStr, statementDay) => {
  const s = getStatementDate(dateStr, statementDay);
  return s === dateStr ? s : getNextStatementDate(s, statementDay);
};

/**
 * Bills charged to the card that a savings goal saves for and that this payment pays (the card's bill
 * window, getCardBillWindow), not yet paid from their fund: the "Use $X from <fund>" lines of the card's
 * Pay dialog. Each: { billId, title, date, amount, recurringGroupId, goalId, goalName, saved, use }, where
 * use = min(saved, bill) is what the fund moves to Checking when the box is checked.
 */
const getCardFundBills = async (card, todayStr, dbTx = null, excludePaymentId = null) => {
  const goals = await Account.findAll({
    where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false }, linkedRecurringGroupId: { [Op.ne]: null } },
    order: [["createdAt", "ASC"]],
    transaction: dbTx,
  });
  if (goals.length === 0) return [];
  const { from, to } = await getCardBillWindow(card, todayStr, dbTx, excludePaymentId);
  const rows = await Transaction.findAll({
    where: {
      type: "EXPENSE",
      fromAccountId: card.id,
      toAccountId: null,
      recurringGroupId: { [Op.in]: [...new Set(goals.map((g) => g.linkedRecurringGroupId))] },
      date: { [Op.gt]: from, [Op.lte]: to },
    },
    order: [["date", "ASC"], ["createdAt", "ASC"]],
    transaction: dbTx,
  });
  if (rows.length === 0) return [];
  const settled = new Set(
    (
      await Setting.findAll({
        where: { key: { [Op.in]: rows.map((r) => `${FUND_PAID_PREFIX}${r.id}`) } },
        transaction: dbTx,
      })
    ).map((s) => s.key.slice(FUND_PAID_PREFIX.length))
  );
  // Several bills from one goal: each uses what the ones before it left
  const left = new Map(goals.map((g) => [g.id, round2(parseFloat(g.initialBalance) || 0)]));
  const result = [];
  for (const row of rows) {
    if (settled.has(row.id)) continue;
    const linked = goals.filter((g) => g.linkedRecurringGroupId === row.recurringGroupId);
    const goal = linked.find((g) => left.get(g.id) > 0) || linked[0];
    const amount = round2(parseFloat(row.amount) || 0);
    const saved = left.get(goal.id);
    const use = round2(Math.max(0, Math.min(saved, amount)));
    left.set(goal.id, round2(saved - use));
    result.push({
      billId: row.id,
      title: row.title,
      date: row.date,
      amount,
      recurringGroupId: row.recurringGroupId,
      goalId: goal.id,
      goalName: goal.name,
      saved,
      use,
    });
  }
  return result;
};

/**
 * A card payment was made (or a scheduled one marked paid). For each bill in fundBills
 * ([{ billId, useFund }], from getCardFundBills): useFund moves min(saved, bill) from its goal to
 * Checking, dated with the payment; either way the goal rolls over to the bill's next charge.
 * Records what was done (fund_paid:<billId>, fund_paid_by:<paymentId>) so un-marking the payment
 * undoes it. Returns [{ billId, title, goalId, goalName, amount, transferId }].
 */
const settleCardFundBills = async (card, payment, fundBills, todayStr, dbTx = null) => {
  if (!Array.isArray(fundBills) || fundBills.length === 0) return [];
  const eligible = new Map(
    (await getCardFundBills(card, todayStr, dbTx, payment.id)).map((b) => [b.billId, b])
  );
  for (const fb of fundBills) {
    if (!eligible.has(fb.billId)) {
      throw new HttpError(400, "That bill isn't on this card payment, or its fund has already paid it.");
    }
  }
  const checking = await getPrimaryCheckingAccount(dbTx);
  const results = [];
  for (const fb of fundBills) {
    const bill = eligible.get(fb.billId);
    let moved = { amount: 0, transfer: null, goal: null };
    if (fb.useFund) moved = await moveFromFund(bill.goalId, bill.amount, bill.title, payment.date, checking, dbTx);
    const rolledOver = await rollOverLinkedFunds(bill.recurringGroupId, todayStr, dbTx);
    await writeJson(
      `${FUND_PAID_PREFIX}${bill.billId}`,
      {
        goalId: bill.goalId,
        transferId: moved.transfer ? moved.transfer.id : null,
        amount: moved.amount,
        paymentId: payment.id,
        rolledOver,
      },
      dbTx
    );
    results.push({
      billId: bill.billId,
      title: bill.title,
      goalId: bill.goalId,
      goalName: bill.goalName,
      amount: moved.amount,
      transferId: moved.transfer ? moved.transfer.id : null,
    });
  }
  const key = `${FUND_PAID_BY_PREFIX}${payment.id}`;
  const before = (await readJson(key, dbTx)) || [];
  await writeJson(key, [...before, ...results.map((r) => r.billId)], dbTx);
  return results;
};

// The sweep marks a scheduled card payment paid on its date: each fund pays, as the boxes default
const settleCardFundBillsByDefault = async (payment, todayStr, dbTx = null) => {
  if (!payment.toAccountId) return [];
  const card = await Account.findByPk(payment.toAccountId, { transaction: dbTx });
  if (!card || card.type !== "CREDIT_CARD") return [];
  const bills = await getCardFundBills(card, todayStr, dbTx, payment.id);
  return settleCardFundBills(
    card,
    payment,
    bills.map((b) => ({ billId: b.billId, useFund: b.use > 0 })),
    todayStr,
    dbTx
  );
};

/**
 * Undoes what a fund did for a bill (fund_paid:<billId>): the transfer out of the goal is reversed and
 * removed, and each goal that rolled over gets its previous due date and target back. Returns the
 * amount put back into the fund, or null when the fund did nothing for the bill. A card charge's fund
 * paid with the card payment, so only un-marking that payment undoes it (byPayment).
 */
const reverseFundPayment = async (billId, dbTx = null, { byPayment = false } = {}) => {
  const key = `${FUND_PAID_PREFIX}${billId}`;
  const record = await readJson(key, dbTx);
  if (!record || (record.paymentId && !byPayment)) return null;
  let amount = 0;
  if (record.transferId) {
    const transfer = await Transaction.findByPk(record.transferId, { transaction: dbTx });
    if (transfer) {
      await adjustAccountForTransaction(transfer, -1, dbTx, true);
      await transfer.destroy({ transaction: dbTx, force: true });
      amount = round2(parseFloat(transfer.amount) || 0);
    }
  }
  for (const r of [...(record.rolledOver || [])].reverse()) {
    const goal = await Account.findByPk(r.goalId, { transaction: dbTx });
    if (!goal) continue;
    await goal.update(
      { dueDate: r.previousDueDate ?? null, targetAmount: r.previousTargetAmount ?? null },
      { transaction: dbTx }
    );
  }
  await Setting.destroy({ where: { key }, transaction: dbTx });
  return amount;
};

// Un-marking a card payment: every bill it paid from a fund is undone (newest first)
const reverseCardFundPayments = async (paymentId, dbTx = null) => {
  const key = `${FUND_PAID_BY_PREFIX}${paymentId}`;
  const billIds = await readJson(key, dbTx);
  if (!Array.isArray(billIds)) return 0;
  let amount = 0;
  for (const billId of [...billIds].reverse()) amount += (await reverseFundPayment(billId, dbTx, { byPayment: true })) || 0;
  await Setting.destroy({ where: { key }, transaction: dbTx });
  return round2(amount);
};

module.exports = {
  computeSinkingFund,
  getLinkedBill,
  getSinkingFunds,
  rollOverLinkedFunds,
  rollOverForPaidBill,
  payLinkedBill,
  payLinkedBillByDefault,
  getCardBillWindow,
  getChargeStatementDate,
  getCardFundBills,
  settleCardFundBills,
  settleCardFundBillsByDefault,
  reverseFundPayment,
  reverseCardFundPayments,
};
