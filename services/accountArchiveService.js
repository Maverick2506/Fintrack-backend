const { Op } = require("sequelize");
const { Account, Transaction } = require("../models");
const {
  adjustAccountForTransaction,
  getTodayString,
} = require("./accountBalanceService");
const { getPrimaryCheckingAccount } = require("./checkingService");
const {
  groupSeries,
  getNextOccurrenceDate,
  getSeriesAnchorDay,
  ACTIVE_RECURRENCES,
} = require("../routes/recurring");

const round2 = (n) => Math.round(n * 100) / 100;

// For rows loaded with their fromAccount/toAccount: true when either account is archived
const usesArchivedAccount = (trx) =>
  trx.fromAccount?.isActive === false || trx.toAccount?.isActive === false;

const isLinkedTo = (trx, accountId) =>
  trx.fromAccountId === accountId || trx.toAccountId === accountId;

// Only charges paid from this account can be paid from Checking instead. Payments and contributions
// going to it (e.g. "Payment for <card>") have nothing left to pay once it is gone, so they always end.
const isMovableToChecking = (trx, accountId) =>
  trx.type === "EXPENSE" && trx.fromAccountId === accountId && !trx.toAccountId;

// Unpaid rows (upcoming, plus any overdue ones) and the active recurring series that use the account
const loadAccountCommitments = async (account, dbTx = null) => {
  const [unpaidRows, allRows] = await Promise.all([
    Transaction.findAll({
      where: {
        isCleared: false,
        [Op.or]: [{ fromAccountId: account.id }, { toAccountId: account.id }],
      },
      order: [["date", "ASC"]],
      transaction: dbTx,
    }),
    Transaction.findAll({
      where: { type: { [Op.in]: ["EXPENSE", "INCOME", "TRANSFER"] } },
      order: [
        ["date", "DESC"],
        ["createdAt", "DESC"],
      ],
      transaction: dbTx,
    }),
  ]);

  const { latestOccurrences, seriesDates, seriesRows } = groupSeries(allRows);
  const activeSeries = Object.keys(latestOccurrences)
    .filter((key) => {
      const latest = latestOccurrences[key];
      return ACTIVE_RECURRENCES.includes(latest.recurrence) && isLinkedTo(latest, account.id);
    })
    .map((key) => ({
      latest: latestOccurrences[key],
      dates: seriesDates[key],
      rows: seriesRows[key],
    }));

  return { unpaidRows, activeSeries };
};

const getDeleteImpact = async (account, dbTx = null) => {
  const { unpaidRows, activeSeries } = await loadAccountCommitments(account, dbTx);
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    balance: round2(parseFloat(account.initialBalance) || 0),
    unpaid: {
      count: unpaidRows.length,
      total: round2(unpaidRows.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0)),
      titles: [...new Set(unpaidRows.map((t) => t.title))],
      movableCount: unpaidRows.filter((t) => isMovableToChecking(t, account.id)).length,
    },
    series: activeSeries.map(({ latest }) => ({
      recurringGroupId: latest.recurringGroupId || latest.id,
      title: latest.title,
      recurrence: latest.recurrence,
      type: latest.type,
      movable: isMovableToChecking(latest, account.id),
    })),
  };
};

// Archives or deletes a card, debt or goal without leaving its unpaid rows and recurring series behind.
// options: { mode: "archive" | "delete", series: "end" | "moveToChecking", moveBalanceToChecking }
// Must run inside dbTx; the caller commits.
const retireAccount = async (account, options, dbTx) => {
  const { mode = "archive", series = "end", moveBalanceToChecking = false } = options || {};
  const todayStr = getTodayString();
  const checking = await getPrimaryCheckingAccount(dbTx);
  const { unpaidRows, activeSeries } = await loadAccountCommitments(account, dbTx);
  const moving = series === "moveToChecking";

  // 1. Unpaid rows: charges move to Checking when asked, everything else is removed
  const movedIds = new Set();
  for (const row of unpaidRows) {
    if (moving && isMovableToChecking(row, account.id)) {
      await row.update({ fromAccountId: checking.id }, { transaction: dbTx });
      movedIds.add(row.id);
    } else {
      await row.destroy({ transaction: dbTx });
    }
  }

  // 2. Recurring series: continue on Checking, or end so the generator never brings them back
  for (const { latest, dates, rows } of activeSeries) {
    if (moving && isMovableToChecking(latest, account.id)) {
      if (movedIds.has(latest.id)) continue; // newest row is already on Checking
      // The newest row is a paid one on this account: start the next occurrence on Checking
      const groupId = latest.recurringGroupId || latest.id;
      if (!latest.recurringGroupId) {
        await Transaction.update(
          { recurringGroupId: groupId },
          { where: { id: rows.map((r) => r.id) }, transaction: dbTx }
        );
      }
      const anchorDay = getSeriesAnchorDay(dates);
      let step = 1;
      let nextDate = getNextOccurrenceDate(latest.date, latest.recurrence, step, anchorDay);
      while (nextDate && nextDate < todayStr) {
        step++;
        nextDate = getNextOccurrenceDate(latest.date, latest.recurrence, step, anchorDay);
      }
      if (!nextDate) continue;
      const baseAmount =
        latest.baseAmount !== null && latest.baseAmount !== undefined
          ? parseFloat(latest.baseAmount)
          : parseFloat(latest.amount);
      await Transaction.create(
        {
          ...latest.get({ plain: true }),
          id: undefined,
          amount: baseAmount,
          baseAmount,
          taxApplied: false,
          isCleared: false,
          balanceApplied: false,
          date: nextDate,
          recurringGroupId: groupId,
          clientRef: null,
          fromAccountId: checking.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { transaction: dbTx }
      );
    } else {
      const remainingIds = rows.filter((r) => !unpaidRows.some((u) => u.id === r.id)).map((r) => r.id);
      if (remainingIds.length > 0) {
        await Transaction.update(
          { recurrence: "none" },
          {
            where: {
              id: remainingIds,
              [Op.or]: [{ fromAccountId: account.id }, { toAccountId: account.id }],
            },
            transaction: dbTx,
          }
        );
      }
    }
  }

  // 3. Money left in a savings goal goes back to Checking as one cleared transfer
  let movedBalance = 0;
  const goalBalance = round2(parseFloat(account.initialBalance) || 0);
  if (account.type === "SAVINGS_GOAL" && moveBalanceToChecking && goalBalance > 0) {
    const transfer = await Transaction.create(
      {
        title: `Moved from ${account.name}`,
        amount: goalBalance,
        date: todayStr,
        type: "TRANSFER",
        category: "Savings Transfer",
        isCleared: true,
        balanceApplied: false,
        fromAccountId: account.id,
        toAccountId: checking.id,
      },
      { transaction: dbTx }
    );
    await adjustAccountForTransaction(transfer, 1, dbTx);
    movedBalance = goalBalance;
  }

  // 4. Archive keeps the account (and its history links); delete unlinks past rows and removes it
  if (mode === "delete") {
    await Transaction.update(
      { fromAccountId: null },
      { where: { fromAccountId: account.id }, transaction: dbTx }
    );
    await Transaction.update(
      { toAccountId: null },
      { where: { toAccountId: account.id }, transaction: dbTx }
    );
    await account.destroy({ transaction: dbTx });
  } else {
    await account.update({ isActive: false }, { transaction: dbTx });
  }

  return {
    mode,
    removedUnpaid: unpaidRows.length - movedIds.size,
    movedUnpaid: movedIds.size,
    movedBalance,
  };
};

module.exports = {
  getDeleteImpact,
  retireAccount,
  isMovableToChecking,
  usesArchivedAccount,
};
