const { Transaction } = require("../models");
const { adjustAccountForTransaction, getTodayString } = require("./accountBalanceService");
const { getCalculatedCheckingBalance } = require("./checkingService");
const { interestTitle } = require("./debtInterestService");
const { HttpError } = require("../middleware/errorHandler");

const round2 = (n) => Math.round(n * 100) / 100;

const RECONCILABLE_TYPES = ["CHECKING", "CREDIT_CARD", "DEBT"];

// Balance the app shows today: Checking is its opening balance plus activity, cards and debts are stored
const getAppBalance = async (account, dbTx) =>
  account.type === "CHECKING"
    ? getCalculatedCheckingBalance(account, getTodayString(), dbTx)
    : round2(parseFloat(account.initialBalance) || 0);

// The one row that moves the balance by `difference`, shaped so accountBalanceService (cards, debts)
// or the Checking activity sums apply it. Only interest charged to a card or debt is an EXPENSE
// (it is spending); every Adjustment is a TRANSFER, so it never counts as spending or income.
const buildReconcileRow = (account, difference, reason) => {
  const amount = round2(Math.abs(difference));
  if (account.type === "CHECKING") {
    // Money in or out of Checking without touching another account
    return difference > 0
      ? { amount, type: "TRANSFER", fromAccountId: null, toAccountId: account.id }
      : { amount, type: "TRANSFER", fromAccountId: account.id, toAccountId: null };
  }
  if (difference > 0) {
    // Card or debt owes more: interest is a charge to it, an adjustment moves the balance up
    return reason === "interest"
      ? { amount, type: "EXPENSE", fromAccountId: account.id, toAccountId: null }
      : { amount, type: "TRANSFER", fromAccountId: account.id, toAccountId: null };
  }
  // Owes less: paid towards it without leaving Checking (the same shape as the adjust-to-$0 row)
  return { amount, type: "TRANSFER", fromAccountId: null, toAccountId: account.id };
};

/**
 * Sync with statement (F4): sets the account to the balance on the user's statement by recording
 * ONE cleared row for the difference, so the history explains the change.
 * body: { actualBalance, date?, reason: "interest" | "adjustment" }. Must run inside dbTx.
 */
const reconcileAccount = async (account, body, dbTx) => {
  if (!RECONCILABLE_TYPES.includes(account.type)) {
    throw new HttpError(400, "Only Checking, credit cards and debts can be synced with a statement.");
  }
  if (account.isActive === false) {
    throw new HttpError(409, "This account is archived, so its balance can't change.");
  }
  const todayStr = getTodayString();
  const date = body.date || todayStr;
  if (date > todayStr) {
    throw new HttpError(400, "The statement date can't be in the future.");
  }

  const appBalance = await getAppBalance(account, dbTx);
  const actualBalance = round2(parseFloat(body.actualBalance));
  const difference = round2(actualBalance - appBalance);
  if (difference === 0) {
    throw new HttpError(409, `The app already shows $${appBalance.toFixed(2)}.`, { balance: appBalance });
  }

  const reason = body.reason === "interest" ? "interest" : "adjustment";
  const trx = await Transaction.create(
    {
      ...buildReconcileRow(account, difference, reason),
      title: reason === "interest" ? interestTitle(account.name) : `Statement sync – ${account.name}`,
      date,
      category: reason === "interest" ? "Interest" : "Adjustment",
      isCleared: true,
      balanceApplied: false,
    },
    { transaction: dbTx }
  );
  // forceApply: a statement date in the past still changes today's balance
  await adjustAccountForTransaction(trx, 1, dbTx, true);

  await account.reload({ transaction: dbTx });
  return {
    transactionId: trx.id,
    previousBalance: appBalance,
    difference,
    balance: await getAppBalance(account, dbTx),
  };
};

module.exports = { reconcileAccount, getAppBalance, RECONCILABLE_TYPES };
