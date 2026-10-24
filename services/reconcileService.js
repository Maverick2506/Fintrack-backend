const { Op } = require("sequelize");
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

// How much one cleared row moved this account's balance (the same rules as accountBalanceService for
// cards and debts, and getCheckingActivity for Checking)
const rowEffect = (account, row) => {
  const amount = parseFloat(row.amount) || 0;
  const id = account.id;
  if (account.type === "CHECKING") {
    if (row.type === "INCOME") return row.toAccountId === id || !row.toAccountId ? amount : 0;
    if (row.fromAccountId === id) return -amount;
    if (row.type === "TRANSFER" && row.toAccountId === id) return amount;
    return 0;
  }
  if (row.toAccountId === id) return -amount;
  if (row.fromAccountId === id && !row.toAccountId) return amount;
  return 0;
};

// Balance as of the end of `date`: today's balance minus what cleared rows dated after it changed.
// A statement from three weeks ago is compared with the balance back then, not with today's.
const getBalanceAsOf = async (account, date, todayStr, dbTx) => {
  const today = await getAppBalance(account, dbTx);
  if (date >= todayStr) return today;
  const where = {
    isCleared: true,
    date: { [Op.gt]: date },
    [Op.or]: [{ fromAccountId: account.id }, { toAccountId: account.id }],
  };
  if (account.type === "CHECKING") {
    // Income without an account lands in Checking, and income only counts once its date comes
    where[Op.or].push({ type: "INCOME", toAccountId: null });
    where[Op.and] = [{ [Op.or]: [{ type: { [Op.ne]: "INCOME" } }, { date: { [Op.lte]: todayStr } }] }];
  } else {
    // Card and debt rows change the stored balance only once applied
    where.balanceApplied = true;
  }
  const rows = await Transaction.findAll({
    where,
    attributes: ["amount", "type", "fromAccountId", "toAccountId"],
    transaction: dbTx,
    raw: true,
  });
  const after = rows.reduce((sum, row) => sum + rowEffect(account, row), 0);
  return round2(today - after);
};

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
 * body: { actualBalance, date?, reason: "interest" | "adjustment" }. actualBalance is the balance on
 * `date` (default today); the row for the difference also moves today's balance. Must run inside dbTx,
 * with the account row locked by the caller.
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
  const balanceOnDate = await getBalanceAsOf(account, date, todayStr, dbTx);
  const actualBalance = round2(parseFloat(body.actualBalance));
  const difference = round2(actualBalance - balanceOnDate);
  if (difference === 0) {
    const on = date < todayStr ? ` on ${date}` : "";
    throw new HttpError(409, `The app already shows $${balanceOnDate.toFixed(2)}${on}.`, { balance: balanceOnDate });
  }

  const reason = body.reason === "interest" ? "interest" : "adjustment";
  // Interest is only ever charged: a card or debt that owes more. A lower statement (a payment made
  // at the bank) or money in or out of Checking is an Adjustment.
  if (reason === "interest" && (account.type === "CHECKING" || difference < 0)) {
    throw new HttpError(
      400,
      account.type === "CHECKING"
        ? "Checking can't be synced as interest. Record the difference as an adjustment."
        : "The statement is lower, so the difference can't be interest. Record it as an adjustment."
    );
  }
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
    balanceOnDate,
    difference,
    balance: await getAppBalance(account, dbTx),
  };
};

module.exports = { reconcileAccount, getAppBalance, getBalanceAsOf, RECONCILABLE_TYPES };
