const { Op } = require("sequelize");
const { Transaction, Account } = require("../models");
const { adjustAccountForTransaction } = require("./accountBalanceService");
const {
  snapshotArchivedBalances,
  assertArchivedBalancesUnchanged,
} = require("./accountArchiveService");
const { ACTIVE_RECURRENCES } = require("../routes/recurring");
const { getPrimaryCheckingAccount } = require("./checkingService");
const { HttpError } = require("../middleware/errorHandler");

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

// What restoring a Trash row does when it uses an archived card, debt or goal (batch 1 retired it):
// - "restore": no archived account, or a paid row whose delete changed no balance (history only)
// - "moveToChecking": an unpaid charge FROM the archived account (e.g. Netflix on the card); putting
//   it back on the account would bring back a phantom bill, so it comes back on Primary Checking
// - "refuse" (refuseReason "nothingToPay"): an unpaid payment or contribution TO the archived account.
//   Archiving ends those (retireAccount), so there is nothing left to pay
// - "refuse" (refuseReason "balance"): a paid row whose restore would change the archived balance
const planRestore = (trx) => {
  const toArchived = trx.toAccount?.isActive === false ? trx.toAccount : null;
  const fromArchived = trx.fromAccount?.isActive === false ? trx.fromAccount : null;
  const archived = toArchived || fromArchived;
  if (!archived) return { action: "restore", archivedAccount: null };
  if (!trx.isCleared) {
    if (toArchived) {
      return { action: "refuse", refuseReason: "nothingToPay", archivedAccount: toArchived.name };
    }
    return { action: "moveToChecking", archivedAccount: fromArchived.name };
  }
  if (trx.balanceReversedOnDelete) {
    return { action: "refuse", refuseReason: "balance", archivedAccount: archived.name };
  }
  return { action: "restore", archivedAccount: archived.name };
};

const refusalMessage = (trx, plan) =>
  plan.refuseReason === "nothingToPay"
    ? `Can't restore '${trx.title}': ${plan.archivedAccount} is archived, so there's nothing left to pay.`
    : `Can't restore '${trx.title}': ${plan.archivedAccount} is archived, and restoring this paid transaction would change its balance.`;

// Restores deleted rows by id and re-applies the balance their delete took off. Must run inside dbTx.
// Unpaid charges from an archived account come back on Primary Checking; unpaid payments to it, and
// paid rows that would change its balance, are left in the Trash (see planRestore). Throws 409 (naming the account) when nothing
// could be restored because of that.
// Returns { restored, moved: [{ id, title, archivedAccount }], refused: [{ id, title, archivedAccount, message }] }.
const restoreTransactions = async (ids, dbTx) => {
  const rows = await Transaction.findAll({
    where: { id: { [Op.in]: ids }, deletedAt: { [Op.ne]: null } },
    include: [
      { model: Account, as: "fromAccount" },
      { model: Account, as: "toAccount" },
    ],
    paranoid: false,
    transaction: dbTx,
  });
  const checking = await getPrimaryCheckingAccount(dbTx);
  const archivedBefore = await snapshotArchivedBalances(dbTx);
  const restored = [];
  const moved = [];
  const refused = [];
  for (const trx of rows) {
    const plan = planRestore(trx);
    if (plan.action === "refuse") {
      refused.push({
        id: trx.id,
        title: trx.title,
        archivedAccount: plan.archivedAccount,
        reason: plan.refuseReason,
        message: refusalMessage(trx, plan),
      });
      continue;
    }
    await trx.restore({ transaction: dbTx });
    if (plan.action === "moveToChecking") {
      // Only charges from the archived account get here; the account's series ended with it
      const changes = { recurrence: "none", fromAccountId: checking.id };
      await trx.update(changes, { transaction: dbTx });
      moved.push({ id: trx.id, title: trx.title, archivedAccount: plan.archivedAccount });
    } else if (trx.balanceReversedOnDelete) {
      // forceApply: the row was applied before its delete, whatever its date
      await adjustAccountForTransaction(trx, 1, dbTx, true);
    }
    trx.balanceReversedOnDelete = false;
    await trx.save({ fields: ["balanceReversedOnDelete"], transaction: dbTx });
    restored.push(trx);
  }
  if (restored.length === 0 && refused.length > 0) {
    throw new HttpError(409, refused.map((r) => r.message).join(" "), { refused });
  }
  // Safety net: nothing above should change an archived balance
  await assertArchivedBalancesUnchanged(archivedBefore, dbTx);
  return { restored, moved, refused };
};

const purgeDateFor = (deletedAt) =>
  deletedAt ? new Date(new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * DAY_MS) : null;

const trashRestorePlan = (t) => {
  const plan = planRestore(t);
  return {
    archivedAccount: plan.archivedAccount,
    restoreAction: plan.action,
    refuseReason: plan.refuseReason || null,
  };
};

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
    // Set when the row uses an archived account: restoreAction says what Restore will do with it
    ...trashRestorePlan(t),
  }));
};

// The generator steps forward from the newest recurring live row of a series and only creates dates
// after its newest live row, skipping dates that already have a row (deleted ones included). A deleted
// occurrence after that newest live row is what stops the generator from re-creating it, so it is kept
// until the series moves past it or ends.
const isSeriesPlaceholder = (trx, liveByGroup) => {
  if (!trx.recurringGroupId) return false;
  const live = liveByGroup.get(trx.recurringGroupId);
  return Boolean(live && live.recurring && live.newestDate < trx.date);
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
  const liveByGroup = new Map();
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
      if (!liveByGroup.has(row.recurringGroupId)) {
        liveByGroup.set(row.recurringGroupId, { newestDate: row.date, recurring: false });
      }
      if (ACTIVE_RECURRENCES.includes(row.recurrence)) {
        liveByGroup.get(row.recurringGroupId).recurring = true;
      }
    }
  }

  const purgeIds = expired
    .filter((t) => !isSeriesPlaceholder(t, liveByGroup))
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
  planRestore,
  listTrash,
  purgeDeletedTransactions,
};
