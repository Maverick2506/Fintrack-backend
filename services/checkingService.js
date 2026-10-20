const { Account, Transaction } = require("../models");
const { Op } = require("sequelize");

const getPrimaryCheckingAccount = async (dbTx = null) => {
  let checking = await Account.findOne({
    where: { type: "CHECKING", isActive: { [Op.ne]: false } },
    order: [["createdAt", "ASC"]],
    transaction: dbTx,
  });
  if (!checking) {
    checking = await Account.findOne({
      where: { name: "Primary Checking" },
      transaction: dbTx,
    });
  }
  if (!checking) {
    checking = await Account.create(
      {
        name: "Primary Checking",
        type: "CHECKING",
        initialBalance: 0.0,
      },
      { transaction: dbTx }
    );
  }
  return checking;
};

const getCheckingActivity = async (checkingId, todayStr, dbTx = null) => {
  const [
    allTimeIncome,
    allTimeCheckingExp,
    allTimeTransfersOut,
    allTimeTransfersIn,
  ] = await Promise.all([
    Transaction.sum("amount", {
      where: {
        type: "INCOME",
        isCleared: true,
        date: { [Op.lte]: todayStr },
        [Op.or]: [{ toAccountId: checkingId }, { toAccountId: null }],
      },
      transaction: dbTx,
    }),
    Transaction.sum("amount", {
      where: {
        type: "EXPENSE",
        isCleared: true,
        fromAccountId: checkingId,
      },
      transaction: dbTx,
    }),
    Transaction.sum("amount", {
      where: {
        type: "TRANSFER",
        isCleared: true,
        fromAccountId: checkingId,
      },
      transaction: dbTx,
    }),
    Transaction.sum("amount", {
      where: {
        type: "TRANSFER",
        isCleared: true,
        toAccountId: checkingId,
      },
      transaction: dbTx,
    }),
  ]);

  const netCheckingActivity =
    (parseFloat(allTimeIncome) || 0) -
    (parseFloat(allTimeCheckingExp) || 0) -
    (parseFloat(allTimeTransfersOut) || 0) +
    (parseFloat(allTimeTransfersIn) || 0);

  return netCheckingActivity;
};

const getCalculatedCheckingBalance = async (checkingAcc, todayStr, dbTx = null) => {
  if (!checkingAcc) return 0;
  const netActivity = await getCheckingActivity(checkingAcc.id, todayStr, dbTx);
  const initial = parseFloat(checkingAcc.initialBalance || 0);
  return Math.round((initial + netActivity) * 100) / 100;
};

module.exports = {
  getPrimaryCheckingAccount,
  getCheckingActivity,
  getCalculatedCheckingBalance,
};
