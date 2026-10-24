const { Op } = require("sequelize");
const { Transaction, Setting } = require("../models");
const { getTodayString } = require("./accountBalanceService");

const round2 = (n) => Math.round(n * 100) / 100;

const ACTIVE_RECURRENCES = ["weekly", "bi-weekly", "monthly", "yearly"];
const recurs = (row) => ACTIVE_RECURRENCES.includes(row.recurrence);

// Per-series Settings (routes/recurring.js): the restart date, and the slots moved rows left
const SERIES_RESTART_PREFIX = "recurring_restart_from:";
const SERIES_VACATED_PREFIX = "recurring_vacated:";

// A series is its recurringGroupId. A row without one is a single row, not a series (getSeriesKey in
// routes/recurring.js): every recurring row has an id, older ones from legacy_series_ids_v1.
const seriesOf = (row) =>
  row.recurringGroupId ? { recurringGroupId: row.recurringGroupId } : { rowId: row.id };

// Every row of a series, Trash included
const findSeriesRows = async (series, dbTx = null) => {
  if (series.recurringGroupId) {
    return Transaction.findAll({
      where: { recurringGroupId: series.recurringGroupId },
      paranoid: false,
      transaction: dbTx,
    });
  }
  const row = await Transaction.findByPk(series.rowId, { paranoid: false, transaction: dbTx });
  return row ? [row] : [];
};

// An id from the client: a recurringGroupId, or the id of one of the series' rows. Null when neither
// matches, and for a row with no group id that does not recur: a plain one-off row is not a series,
// so same-titled bills are never touched.
const resolveSeries = async (id, dbTx = null) => {
  const inGroup = await Transaction.count({
    where: { recurringGroupId: id },
    paranoid: false,
    transaction: dbTx,
  });
  if (inGroup > 0) return { recurringGroupId: id };
  const row = await Transaction.findByPk(id, { paranoid: false, transaction: dbTx });
  if (!row) return null;
  if (row.recurringGroupId) return seriesOf(row);
  return recurs(row) ? seriesOf(row) : null;
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
// Paid and past rows are kept.
// options: dryRun only reports; keepIds are never removed (the row being edited); requireRecurring
// (default true) reports { alreadyEnded: true } and changes nothing when no row still recurs. The
// B3 edit and account archive pass false: the edit has just set the last recurring row to One-time.
// Must run inside dbTx for a real end.
const endSeries = async (
  series,
  {
    dryRun = false,
    keepIds = [],
    todayStr = getTodayString(),
    requireRecurring = true,
    dbTx = null,
  } = {}
) => {
  const rows = await findSeriesRows(series, dbTx);
  if (requireRecurring && !rows.some(recurs)) {
    return {
      seriesEnded: false,
      alreadyEnded: true,
      removedUpcomingCount: 0,
      removedUpcomingTotal: 0,
      keptCount: rows.filter((r) => !r.deletedAt).length,
    };
  }
  const keep = new Set(keepIds);
  const upcoming = rows.filter(
    (r) => !r.deletedAt && !r.isCleared && r.date > todayStr && !keep.has(r.id)
  );
  const upcomingIds = new Set(upcoming.map((r) => r.id));
  const result = {
    seriesEnded: true,
    alreadyEnded: false,
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
  // An ended series no longer needs its restart date or vacated slots
  if (series.recurringGroupId) {
    await Setting.destroy({
      where: {
        key: [
          `${SERIES_RESTART_PREFIX}${series.recurringGroupId}`,
          `${SERIES_VACATED_PREFIX}${series.recurringGroupId}`,
        ],
      },
      transaction: dbTx,
    });
  }
  return result;
};

module.exports = {
  ACTIVE_RECURRENCES,
  SERIES_RESTART_PREFIX,
  SERIES_VACATED_PREFIX,
  seriesOf,
  findSeriesRows,
  resolveSeries,
  findCurrentOccurrence,
  endSeries,
};
