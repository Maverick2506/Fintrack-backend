const { Op } = require("sequelize");
const { Transaction } = require("../models");
const { getTodayString } = require("./accountBalanceService");

const round2 = (n) => Math.round(n * 100) / 100;

// A series is its recurringGroupId. An older series without one is the rows with the same type and
// title and no group id, the way the generator groups them.
const seriesOf = (row) =>
  row.recurringGroupId
    ? { recurringGroupId: row.recurringGroupId }
    : { type: row.type, title: row.title };

// Every row of a series, Trash included
const findSeriesRows = async (series, dbTx = null) => {
  if (series.recurringGroupId) {
    return Transaction.findAll({
      where: { recurringGroupId: series.recurringGroupId },
      paranoid: false,
      transaction: dbTx,
    });
  }
  const titleKey = String(series.title || "").toLowerCase().trim();
  const rows = await Transaction.findAll({
    where: { type: series.type, recurringGroupId: null },
    paranoid: false,
    transaction: dbTx,
  });
  return rows.filter((t) => t.title.toLowerCase().trim() === titleKey);
};

// An id from the client: a recurringGroupId, or the id of one of the series' rows (older series
// have no group id). Null when neither matches.
const resolveSeries = async (id, dbTx = null) => {
  const inGroup = await Transaction.count({
    where: { recurringGroupId: id },
    paranoid: false,
    transaction: dbTx,
  });
  if (inGroup > 0) return { recurringGroupId: id };
  const row = await Transaction.findByPk(id, { paranoid: false, transaction: dbTx });
  return row ? seriesOf(row) : null;
};

// The series' current occurrence (B3): its newest live row dated today or earlier, or its first row
// when none has come due yet
const findCurrentOccurrence = (rows, todayStr) => {
  const live = rows
    .filter((r) => !r.deletedAt)
    .sort((a, b) =>
      a.date === b.date
        ? new Date(a.createdAt) - new Date(b.createdAt)
        : a.date < b.date
        ? -1
        : 1
    );
  const due = live.filter((r) => r.date <= todayStr);
  return due.length > 0 ? due[due.length - 1] : live[0] || null;
};

// The single "end series" path: POST /recurring/:id/end, Subscriptions cancel, the B3 edit of the
// current occurrence, and archiving an account. Every row of the series stops recurring, Trash
// included, so neither the generator nor a restore brings it back. Its unpaid rows dated after
// today are removed for good (not sent to the Trash: restoring one would restart the series).
// Paid and past rows are kept. dryRun only reports. keepIds are never removed (the row being edited).
// Must run inside dbTx for a real end.
const endSeries = async (
  series,
  { dryRun = false, keepIds = [], todayStr = getTodayString(), dbTx = null } = {}
) => {
  const rows = await findSeriesRows(series, dbTx);
  const keep = new Set(keepIds);
  const upcoming = rows.filter(
    (r) => !r.deletedAt && !r.isCleared && r.date > todayStr && !keep.has(r.id)
  );
  const upcomingIds = new Set(upcoming.map((r) => r.id));
  const result = {
    seriesEnded: true,
    removedUpcomingCount: upcoming.length,
    removedUpcomingTotal: round2(upcoming.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)),
    keptCount: rows.filter((r) => !r.deletedAt && !upcomingIds.has(r.id)).length,
  };
  if (dryRun) return result;

  if (upcoming.length > 0) {
    await Transaction.destroy({
      where: { id: { [Op.in]: [...upcomingIds] } },
      force: true,
      transaction: dbTx,
    });
  }
  const remainingIds = rows.filter((r) => !upcomingIds.has(r.id)).map((r) => r.id);
  if (remainingIds.length > 0) {
    await Transaction.update(
      { recurrence: "none" },
      { where: { id: { [Op.in]: remainingIds } }, paranoid: false, transaction: dbTx }
    );
  }
  return result;
};

module.exports = {
  seriesOf,
  findSeriesRows,
  resolveSeries,
  findCurrentOccurrence,
  endSeries,
};
