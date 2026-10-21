const { Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime } = require("date-fns-tz");

const TIMEZONE = "America/Toronto";

/**
 * Calculates current-year contribution room and pacing for registered accounts (TFSA, RRSP, FHSA).
 * Matches Phase J savingsGoals logic precisely:
 * Room Left = contributionRoom - contributionsMadeThisYear
 */
const getRegisteredAccountsSummary = async (dbTx = null) => {
  const registeredGoals = await Account.findAll({
    where: {
      type: "SAVINGS_GOAL",
      isActive: { [Op.ne]: false },
      registeredType: { [Op.ne]: null },
    },
    transaction: dbTx,
  });

  if (registeredGoals.length === 0) return [];

  const nowZoned = toZonedTime(new Date(), TIMEZONE);
  const currentYear = nowZoned.getFullYear();

  const results = [];

  for (const rg of registeredGoals) {
    const year = rg.roomYear || currentYear;
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [inflow, outflow] = await Promise.all([
      Transaction.sum("amount", {
        where: {
          toAccountId: rg.id,
          isCleared: true,
          date: { [Op.between]: [yearStart, yearEnd] },
        },
        transaction: dbTx,
      }),
      Transaction.sum("amount", {
        where: {
          fromAccountId: rg.id,
          isCleared: true,
          date: { [Op.between]: [yearStart, yearEnd] },
        },
        transaction: dbTx,
      }),
    ]);

    const contRoom =
      rg.contributionRoom !== null && rg.contributionRoom !== undefined
        ? parseFloat(rg.contributionRoom)
        : null;

    const contributedThisYear = Math.round((parseFloat(inflow) || 0) * 100) / 100;
    const withdrawnThisYear = Math.round((parseFloat(outflow) || 0) * 100) / 100;
    const roomLeft =
      contRoom !== null
        ? Math.round((contRoom - contributedThisYear) * 100) / 100
        : null;

    results.push({
      id: rg.id,
      name: rg.name,
      registeredType: rg.registeredType,
      currentBalance: parseFloat(rg.initialBalance || 0),
      contributionRoom: contRoom,
      roomYear: year,
      contributedThisYear,
      withdrawnThisYear,
      roomLeft,
      isOverContributed: contRoom !== null && contributedThisYear > contRoom,
    });
  }

  return results;
};

module.exports = {
  getRegisteredAccountsSummary,
};
