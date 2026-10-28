const { Op } = require("sequelize");
const { Account, Transaction } = require("../models");
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
  if (!series) return { ...base, ended: true, recurrence: "none", amount: null, nextDate: null };

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
    recurrence: template.recurrence,
    amount: round2(amount || 0),
    nextDate,
    // Charged to Checking (not a card): the forecast counts it on its date
    fromChecking: !template.fromAccount || template.fromAccount.type === "CHECKING",
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

  const monthStart = `${todayStr.slice(0, 7)}-01`;
  const monthEnd = `${todayStr.slice(0, 7)}-31`;
  const goalSeries = groupSeries(goalRows.filter((r) => r.recurringGroupId || ACTIVE_RECURRENCES.includes(r.recurrence)));

  for (const goal of linkedGoals) {
    const bill = getLinkedBill(
      billRows.filter((r) => r.recurringGroupId === goal.linkedRecurringGroupId),
      todayStr
    );
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

module.exports = { computeSinkingFund, getLinkedBill, getSinkingFunds };
