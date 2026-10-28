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

  return {
    statementDay,
    statementDate,
    nextStatementDate: getNextStatementDate(statementDate, statementDay),
    dueDate,
    statementBalance,
    newCharges,
  };
};

module.exports = {
  getStatementDate,
  getNextStatementDate,
  getStatementDueDate,
  getCardStatement,
};
