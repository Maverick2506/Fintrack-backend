const { Account } = require("../models");
const { Op } = require("sequelize");
const {
  getPrimaryCheckingAccount,
  getCalculatedCheckingBalance,
} = require("./checkingService");
const { getTodayString } = require("./accountBalanceService");

/**
 * Computes a unified balances summary and net worth across all active accounts.
 *
 * @param {import("sequelize").Transaction|null} [dbTx=null]
 * @param {string|null} [asOfDateStr=null] YYYY-MM-DD date string (defaults to today America/Toronto)
 * @returns {Promise<{
 *   checking: number,
 *   savings: number,
 *   debt: number,
 *   cards: number,
 *   netWorth: number
 * }>}
 */
const getBalancesSummary = async (dbTx = null, asOfDateStr = null) => {
  const todayStr = asOfDateStr || getTodayString();

  const [checkingAcc, allAccounts] = await Promise.all([
    getPrimaryCheckingAccount(dbTx),
    Account.findAll({
      where: {
        isActive: { [Op.ne]: false },
      },
      transaction: dbTx,
    }),
  ]);

  const checking = await getCalculatedCheckingBalance(checkingAcc, todayStr, dbTx);

  const savingsAccs = allAccounts.filter((a) => a.type === "SAVINGS_GOAL");
  const debtAccs = allAccounts.filter(
    (a) => a.type === "DEBT" && parseFloat(a.initialBalance || 0) > 0
  );
  const cardAccs = allAccounts.filter((a) => a.type === "CREDIT_CARD");

  const savings =
    Math.round(
      savingsAccs.reduce(
        (sum, a) => sum + (parseFloat(a.initialBalance) || 0),
        0
      ) * 100
    ) / 100;

  const debt =
    Math.round(
      debtAccs.reduce(
        (sum, a) => sum + (parseFloat(a.initialBalance) || 0),
        0
      ) * 100
    ) / 100;

  const cards =
    Math.round(
      cardAccs.reduce(
        (sum, a) => sum + (parseFloat(a.initialBalance) || 0),
        0
      ) * 100
    ) / 100;

  const netWorth = Math.round((checking + savings - debt - cards) * 100) / 100;

  return {
    checking,
    savings,
    debt,
    cards,
    netWorth,
  };
};

module.exports = {
  getBalancesSummary,
};
