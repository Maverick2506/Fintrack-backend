const { Op } = require("sequelize");
const { Transaction } = require("../models");

// Card statement cycles. A card with a statementDay closes its statement on that day each month (the
// last day of a shorter month: 31 -> Feb 28, Apr 30). Charges dated on the statement date are on that
// statement; charges after it are "new charges" for the next one.

const pad = (n) => String(n).padStart(2, "0");
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// The given day in month m (1-12) of year y, clamped to the month's last day
const dayInMonth = (y, m, day) => `${y}-${pad(m)}-${pad(Math.min(day, daysInMonth(y, m)))}`;
const shiftMonth = (y, m, by) => {
  const total = y * 12 + (m - 1) + by;
  return [Math.floor(total / 12), (total % 12) + 1];
};

// The most recent statement date on or before todayStr
const getStatementDate = (todayStr, statementDay) => {
  const [y, m] = todayStr.split("-").map(Number);
  const thisMonth = dayInMonth(y, m, statementDay);
  if (thisMonth <= todayStr) return thisMonth;
  const [py, pm] = shiftMonth(y, m, -1);
  return dayInMonth(py, pm, statementDay);
};

// The statement date after statementDate
const getNextStatementDate = (statementDate, statementDay) => {
  const [y, m] = statementDate.split("-").map(Number);
  const [ny, nm] = shiftMonth(y, m, 1);
  return dayInMonth(ny, nm, statementDay);
};

// A statement's payment is due on the first dueDay after it closes (same month when dueDay is later)
const getStatementDueDate = (statementDate, dueDay) => {
  const [y, m] = statementDate.split("-").map(Number);
  const sameMonth = dayInMonth(y, m, dueDay);
  if (sameMonth > statementDate) return sameMonth;
  const [ny, nm] = shiftMonth(y, m, 1);
  return dayInMonth(ny, nm, dueDay);
};

const round2 = (n) => Math.round(n * 100) / 100;

// Charges not on the card's balance yet (unpaid rows from the card: scheduled purchases, pending
// charges) dated on or before dateStr. Refunds count negative.
const getPendingCardCharges = async (cardId, dateStr, dbTx = null) => {
  const sum = await Transaction.sum("amount", {
    where: {
      fromAccountId: cardId,
      toAccountId: null,
      type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
      isCleared: false,
      date: { [Op.lte]: dateStr },
    },
    transaction: dbTx,
  });
  return round2(parseFloat(sum) || 0);
};

/**
 * The card's full balance projected for dateStr: today's balance, plus unpaid charges dated by then,
 * minus other unpaid payments to the card dated before it (or the same day, entered earlier).
 * excludeId leaves one payment out (the one being checked).
 */
const getProjectedCardBalance = async (card, dateStr, dbTx = null, excludeId = null) => {
  const balance = parseFloat(card.initialBalance) || 0;
  const charges = await getPendingCardCharges(card.id, dateStr, dbTx);
  const payments = await Transaction.sum("amount", {
    where: {
      toAccountId: card.id,
      type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
      isCleared: false,
      date: { [Op.lt]: dateStr },
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    transaction: dbTx,
  });
  return round2(balance + charges - (parseFloat(payments) || 0));
};

// The date a payment for this statement is checked against: its due date, today when it is overdue
// and unpaid, or the next statement's due date once it is paid
const getPaymentWindowEnd = (statement, todayStr) => {
  if (!statement.dueDate) return null;
  if (statement.dueDate >= todayStr) return statement.dueDate;
  return statement.statementBalance > 0 ? todayStr : statement.nextDueDate;
};

/**
 * The next unpaid payment scheduled to the card, up to the payment window's end, compared with the
 * statement: { id, title, date, amount, recurrence, projectedBalance, toNewCharges, excess }.
 * - toNewCharges: what the payment pays beyond the statement balance (up to the full balance)
 * - excess: what it pays beyond the full balance projected for its date ("more than you owe")
 * The scheduled amount is never changed here. null when nothing is scheduled.
 */
const getScheduledCardPayment = async (card, statement, todayStr, dbTx = null) => {
  const windowEnd = getPaymentWindowEnd(statement, todayStr);
  if (!windowEnd) return null;
  const row = await Transaction.findOne({
    where: {
      toAccountId: card.id,
      type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
      isCleared: false,
      date: { [Op.lte]: windowEnd },
    },
    order: [["date", "ASC"], ["createdAt", "ASC"]],
    transaction: dbTx,
  });
  if (!row) return null;
  const amount = round2(parseFloat(row.amount) || 0);
  const projectedBalance = await getProjectedCardBalance(card, row.date < todayStr ? todayStr : row.date, dbTx, row.id);
  const owed = Math.max(0, projectedBalance);
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    amount,
    recurrence: row.recurrence,
    projectedBalance: round2(owed),
    toNewCharges: round2(Math.max(0, Math.min(amount, owed) - statement.statementBalance)),
    excess: round2(Math.max(0, amount - owed)),
  };
};

/**
 * Splits a card's balance around its last statement date.
 * - newCharges: cleared rows that raised the card after the statement date, up to today (purchases,
 *   interest and upward adjustments; refunds count negative).
 * - statementBalance: what is still owed on the last statement = balance - newCharges, so payments
 *   made since lower it. Never below 0 or above the balance.
 * - dueDate: from the card's due day (the day of its dueDate), or null when the card has none.
 * Returns null when the card has no statementDay.
 */
const getCardStatement = async (card, todayStr, dbTx = null) => {
  const statementDay = parseInt(card.statementDay, 10);
  if (!statementDay || statementDay < 1 || statementDay > 31) return null;

  const statementDate = getStatementDate(todayStr, statementDay);
  const dueDay = card.dueDate ? Number(String(card.dueDate).split("-")[2]) : null;
  const dueDate = dueDay ? getStatementDueDate(statementDate, dueDay) : null;

  const charged = await Transaction.sum("amount", {
    where: {
      fromAccountId: card.id,
      toAccountId: null,
      type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
      isCleared: true,
      date: { [Op.gt]: statementDate, [Op.lte]: todayStr },
    },
    transaction: dbTx,
  });
  const newCharges = round2(parseFloat(charged) || 0);
  const balance = parseFloat(card.initialBalance) || 0;
  const statementBalance = round2(Math.min(Math.max(0, balance), Math.max(0, balance - newCharges)));

  const nextStatementDate = getNextStatementDate(statementDate, statementDay);
  const statement = {
    statementDay,
    statementDate,
    nextStatementDate,
    dueDate,
    // The next statement's due date, for when this one's has passed
    nextDueDate: dueDay ? getStatementDueDate(nextStatementDate, dueDay) : null,
    statementBalance,
    newCharges,
  };
  statement.scheduledPayment = await getScheduledCardPayment(card, statement, todayStr, dbTx);
  return statement;
};

module.exports = {
  getStatementDate,
  getNextStatementDate,
  getStatementDueDate,
  getCardStatement,
  getPendingCardCharges,
  getProjectedCardBalance,
  getScheduledCardPayment,
  getPaymentWindowEnd,
};
