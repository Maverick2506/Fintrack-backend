const { Op } = require("sequelize");
const { Transaction, Account } = require("../models");
const { adjustAccountForTransaction } = require("./accountBalanceService");
const {
  snapshotArchivedBalances,
  assertArchivedBalancesUnchanged,
} = require("./accountArchiveService");
const { ACTIVE_RECURRENCES } = require("../routes/recurring");

// Trash (soft delete): a deleted transaction keeps its row with deletedAt set, so it can be restored.
// Delete takes its balance off any card, debt or goal; restore puts exactly that back.
// The nightly sweep purges rows deleted more than TRASH_RETENTION_DAYS ago.
const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;

// Reverses each row's balance (when it was applied) and soft-deletes it. Must run inside dbTx.
// A row on an archived account whose balance would change is refused with 409 (the caller rolls back).
const softDeleteTransactions = async (rows, dbTx) => {
  const archivedBefore = await snapshotArchivedBalances(dbTx);
  for (const trx of rows) {
    const wasApplied = Boolean(trx.balanceApplied);
    await adjustAccountForTransaction(trx, -1, dbTx);
    trx.balanceReversedOnDelete = wasApplied;
    await trx.save({ fields: ["balanceReversedOnDelete"], transaction: dbTx });
  }
  await assertArchivedBalancesUnchanged(archivedBefore, dbTx);
  if (rows.length === 0) return 0;
  return Transaction.destroy({
    where: { id: { [Op.in]: rows.map((r) => r.id) } },
    transaction: dbTx,
  });
};

// Restores deleted rows by id and re-applies the balance their delete took off. Must run inside dbTx.
// Returns the restored rows. Restoring onto an archived account is refused (409) only when it would
// change that account's balance, the same rule as delete.
const restoreTransactions = async (ids, dbTx) => {
  const rows = await Transaction.findAll({
    where: { id: { [Op.in]: ids }, deletedAt: { [Op.ne]: null } },
    paranoid: false,
    transaction: dbTx,
  });
  const archivedBefore = await snapshotArchivedBalances(dbTx);
  for (const trx of rows) {
    await trx.restore({ transaction: dbTx });
    if (trx.balanceReversedOnDelete) {
      // forceApply: the row was applied before its delete, whatever its date
      await adjustAccountForTransaction(trx, 1, dbTx, true);
    }
    trx.balanceReversedOnDelete = false;
    await trx.save({ fields: ["balanceReversedOnDelete"], transaction: dbTx });
  }
  await assertArchivedBalancesUnchanged(archivedBefore, dbTx);
  return rows;
};

const purgeDateFor = (deletedAt) =>
  deletedAt ? new Date(new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * DAY_MS) : null;

// Deleted rows, most recently deleted first, shaped like Ledger rows
const listTrash = async () => {
  const rows = await Transaction.findAll({
    where: { deletedAt: { [Op.ne]: null } },
    paranoid: false,
    order: [
      ["deletedAt", "DESC"],
      ["date", "DESC"],
    ],
    include: [
      { model: Account, as: "fromAccount" },
      { model: Account, as: "toAccount" },
    ],
  });
  return rows.map((t) => ({
    id: t.id,
    type: t.type.toLowerCase(),
    name: t.title,
    amount: round2(parseFloat(t.amount) || 0),
    date: t.date,
    category: t.category,
    is_paid: t.isCleared,
    recurrence: t.recurrence || "none",
    recurringGroupId: t.recurringGroupId || null,
    fromAccount: t.fromAccount ? t.fromAccount.name : null,
    toAccount: t.toAccount ? t.toAccount.name : null,
    fromAccountType: t.fromAccount ? t.fromAccount.type : null,
    toAccountType: t.toAccount ? t.toAccount.type : null,
    fromAccountArchived: t.fromAccount?.isActive === false,
    toAccountArchived: t.toAccount?.isActive === false,
    deletedAt: t.deletedAt,
    purgeAfter: purgeDateFor(t.deletedAt),
  }));
};

// The generator follows the newest live row of a series and steps forward from it, skipping dates
// that already have a row (deleted ones included). A deleted occurrence after that newest live row
// is what stops the generator from re-creating it, so it is kept until the series moves past it.
const isSeriesPlaceholder = (trx, newestLiveByGroup) => {
  if (!trx.recurringGroupId) return false;
  const newest = newestLiveByGroup.get(trx.recurringGroupId);
  return Boolean(
    newest && ACTIVE_RECURRENCES.includes(newest.recurrence) && newest.date < trx.date
  );
};

// Permanently removes rows deleted more than TRASH_RETENTION_DAYS before `now`. Returns the count.
const purgeDeletedTransactions = async ({ now = new Date(), dbTx = null } = {}) => {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const expired = await Transaction.findAll({
    where: { deletedAt: { [Op.lt]: cutoff } },
    attributes: ["id", "date", "recurringGroupId"],
    paranoid: false,
    transaction: dbTx,
  });
  if (expired.length === 0) return 0;

  const groupIds = [...new Set(expired.map((t) => t.recurringGroupId).filter(Boolean))];
  const newestLiveByGroup = new Map();
  if (groupIds.length > 0) {
    const live = await Transaction.findAll({
      where: { recurringGroupId: { [Op.in]: groupIds } },
      attributes: ["recurringGroupId", "date", "recurrence"],
      order: [
        ["date", "DESC"],
        ["createdAt", "DESC"],
      ],
      transaction: dbTx,
    });
    for (const row of live) {
      if (!newestLiveByGroup.has(row.recurringGroupId)) {
        newestLiveByGroup.set(row.recurringGroupId, row);
      }
    }
  }

  const purgeIds = expired
    .filter((t) => !isSeriesPlaceholder(t, newestLiveByGroup))
    .map((t) => t.id);
  if (purgeIds.length === 0) return 0;
  return Transaction.destroy({
    where: { id: { [Op.in]: purgeIds }, deletedAt: { [Op.ne]: null } },
    force: true,
    transaction: dbTx,
  });
};

module.exports = {
  TRASH_RETENTION_DAYS,
  softDeleteTransactions,
  restoreTransactions,
  listTrash,
  purgeDeletedTransactions,
};
