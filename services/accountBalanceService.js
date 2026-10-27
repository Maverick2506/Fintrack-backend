const { Account } = require("../models");
const { toZonedTime, format } = require("date-fns-tz");

const TIMEZONE = "America/Toronto";

const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

// Apply or reverse balance effect of a cleared transaction on linked non-checking accounts
const adjustAccountForTransaction = async (
  trx,
  direction = 1,
  dbTx = null,
  forceApply = false
) => {
  const amount = parseFloat(trx.amount) || 0;
  if (amount === 0) return;

  const todayStr = getTodayString();
  const isPastDated = trx.date < todayStr;

  let toAcc = null;
  if (trx.toAccountId) {
    toAcc = await Account.findByPk(trx.toAccountId, { transaction: dbTx });
  }
  const isSavingsGoal = Boolean(toAcc && toAcc.type === "SAVINGS_GOAL");

  if (direction === 1) {
    // Already applied? Skip to prevent double counting
    if (trx.balanceApplied) return;

    // Unpaid/pending expenses or transfers have not affected account balances yet
    if (!trx.isCleared) return;

    // Historical past-dated transactions (created with a past date) on cards/debts were already in opening balance.
    // Savings goals are exempt: every contribution towards a savings goal adds to the goal regardless of date.
    // If forceApply is true (e.g. editing an already-applied transaction or overdue bill paid), re-apply regardless of date.
    if (isPastDated && !trx.balanceApplied && !forceApply && !isSavingsGoal) {
      trx.balanceApplied = false;
      await trx.save({ fields: ["balanceApplied"], transaction: dbTx });
      return;
    }

    let applied = false;
    // 1. Cleared expense charged FROM a Credit Card, or interest/adjustment charged to a Debt
    if (trx.type === "EXPENSE" && trx.fromAccountId && !trx.toAccountId) {
      const fromAcc = await Account.findByPk(trx.fromAccountId, { transaction: dbTx });
      if (fromAcc && (fromAcc.type === "CREDIT_CARD" || fromAcc.type === "DEBT")) {
        await Account.increment("initialBalance", {
          by: amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
        applied = true;
      }
    }

    // 2. Cleared EXPENSE or TRANSFER directed TO a Debt, Credit Card, or Savings Goal
    if ((trx.type === "EXPENSE" || trx.type === "TRANSFER") && trx.toAccountId) {
      if (toAcc) {
        if (toAcc.type === "CREDIT_CARD" || toAcc.type === "DEBT") {
          await Account.increment("initialBalance", {
            by: -amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
          applied = true;
        } else if (toAcc.type === "SAVINGS_GOAL") {
          await Account.increment("initialBalance", {
            by: amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
          applied = true;
        }
      }
    }

    // 3. Cleared TRANSFER out of a Savings Goal (money moved back to checking).
    //    Only the archive, final-payment and adjust-to-$0 flows (accountArchiveService) create these rows.
    //    A TRANSFER out of a card or debt to no account is a statement-sync Adjustment that raises
    //    what is owed (reconcileService); it is not spending.
    if (trx.type === "TRANSFER" && trx.fromAccountId) {
      const fromAcc = await Account.findByPk(trx.fromAccountId, { transaction: dbTx });
      if (fromAcc && fromAcc.type === "SAVINGS_GOAL") {
        await Account.increment("initialBalance", {
          by: -amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
        applied = true;
      } else if (
        fromAcc &&
        !trx.toAccountId &&
        (fromAcc.type === "CREDIT_CARD" || fromAcc.type === "DEBT")
      ) {
        await Account.increment("initialBalance", {
          by: amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
        applied = true;
      }
    }

    if (applied) {
      trx.balanceApplied = true;
      await trx.save({ fields: ["balanceApplied"], transaction: dbTx });
    }
  } else if (direction === -1) {
    // Only reverse if balance was actually applied!
    if (!trx.balanceApplied) return;

    // 1. Reverse expense charged FROM a Credit Card or a Debt
    if (trx.type === "EXPENSE" && trx.fromAccountId && !trx.toAccountId) {
      const fromAcc = await Account.findByPk(trx.fromAccountId, { transaction: dbTx });
      if (fromAcc && (fromAcc.type === "CREDIT_CARD" || fromAcc.type === "DEBT")) {
        await Account.increment("initialBalance", {
          by: -amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
      }
    }

    // 2. Reverse EXPENSE or TRANSFER directed TO a Debt, Credit Card, or Savings Goal
    if ((trx.type === "EXPENSE" || trx.type === "TRANSFER") && trx.toAccountId) {
      if (toAcc) {
        if (toAcc.type === "CREDIT_CARD" || toAcc.type === "DEBT") {
          await Account.increment("initialBalance", {
            by: amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
        } else if (toAcc.type === "SAVINGS_GOAL") {
          await Account.increment("initialBalance", {
            by: -amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
        }
      }
    }

    // 3. Reverse TRANSFER out of a Savings Goal, or a statement-sync Adjustment up on a card or debt
    if (trx.type === "TRANSFER" && trx.fromAccountId) {
      const fromAcc = await Account.findByPk(trx.fromAccountId, { transaction: dbTx });
      if (fromAcc && fromAcc.type === "SAVINGS_GOAL") {
        await Account.increment("initialBalance", {
          by: amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
      } else if (
        fromAcc &&
        !trx.toAccountId &&
        (fromAcc.type === "CREDIT_CARD" || fromAcc.type === "DEBT")
      ) {
        await Account.increment("initialBalance", {
          by: -amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
      }
    }

    trx.balanceApplied = false;
    await trx.save({ fields: ["balanceApplied"], transaction: dbTx });
  }
};

// How much one cleared row moves Checking's balance, which is computed from its rows
// (the same sums as checkingService.getCheckingActivity)
const checkingEffect = (trx, checkingId) => {
  const amount = parseFloat(trx.amount) || 0;
  if (!trx.isCleared || !checkingId) return 0;
  if (trx.type === "INCOME") return trx.toAccountId === checkingId || !trx.toAccountId ? amount : 0;
  let effect = 0;
  if ((trx.type === "EXPENSE" || trx.type === "TRANSFER") && trx.fromAccountId === checkingId) effect -= amount;
  if (trx.type === "TRANSFER" && trx.toAccountId === checkingId) effect += amount;
  return effect;
};

// Records a cleared imported row against balances one side at a time. A row can touch two accounts
// (a card payment leaves Checking and reaches the card), and each side is history when its own
// account's balance was set or synced on or after the row's date (balanceAnchorService):
// - the stored side (card, debt, savings goal) is applied through adjustAccountForTransaction, or,
//   when it's history, only marked applied so editing or deleting the row later works like any other;
// - Checking is computed from its rows, so when its side is history its opening balance takes the
//   opposite of what the row adds. previousCheckingEffect is the row's Checking effect before this
//   change (a card payment the card statement recorded, that now comes out of Checking).
// A row already marked applied (the other statement recorded it) keeps its stored side as it is.
const applyImportedRow = async (
  trx,
  checkingId,
  { checkingHistory = false, storedHistory = false } = {},
  dbTx = null,
  previousCheckingEffect = 0
) => {
  if (!trx.isCleared) return;
  if (!trx.balanceApplied) {
    if (!storedHistory) await adjustAccountForTransaction(trx, 1, dbTx, true);
    if ((storedHistory || checkingHistory) && !trx.balanceApplied) {
      trx.balanceApplied = true;
      await trx.save({ fields: ["balanceApplied"], transaction: dbTx });
    }
  }
  if (checkingHistory) {
    const change = checkingEffect(trx, checkingId) - previousCheckingEffect;
    if (change !== 0) {
      await Account.increment("initialBalance", {
        by: -change,
        where: { id: checkingId },
        transaction: dbTx,
      });
    }
  }
};

module.exports = {
  adjustAccountForTransaction,
  checkingEffect,
  applyImportedRow,
  getTodayString,
  TIMEZONE,
};
