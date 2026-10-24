const express = require("express");
const crypto = require("crypto");
const { Transaction, Setting, Account } = require("../models");
const { Op } = require("sequelize");
const { addDays, addMonths, addYears } = require("date-fns");
const { toZonedTime, format } = require("date-fns-tz");
const cronAuthMiddleware = require("../middleware/cronAuthMiddleware");
const router = express.Router();

const TIMEZONE = "America/Toronto";

// Pure calendar recurrence calculation helper (pure YYYY-MM-DD arithmetic, completely immune to server timezone or DST boundaries)
// anchorDay (monthly/yearly only) is the day of month the series is meant to fall on, so a date clamped
// to a short month (Jan 31 -> Feb 28) returns to the 31st afterwards instead of drifting (N4).
const getNextOccurrenceDate = (baseDateStr, recurrence, step = 1, anchorDay = null) => {
  if (!baseDateStr) return null;
  const parts = String(baseDateStr).split("T")[0].split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [baseYear, baseMonth, baseDay] = parts;

  switch (recurrence) {
    case "weekly": {
      const baseUtc = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay, 12, 0, 0));
      const targetUtc = new Date(baseUtc.getTime() + step * 7 * 24 * 60 * 60 * 1000);
      const y = targetUtc.getUTCFullYear();
      const m = String(targetUtc.getUTCMonth() + 1).padStart(2, "0");
      const d = String(targetUtc.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    case "bi-weekly": {
      const baseUtc = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay, 12, 0, 0));
      const targetUtc = new Date(baseUtc.getTime() + step * 14 * 24 * 60 * 60 * 1000);
      const y = targetUtc.getUTCFullYear();
      const m = String(targetUtc.getUTCMonth() + 1).padStart(2, "0");
      const d = String(targetUtc.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    case "monthly": {
      const totalMonths = baseYear * 12 + (baseMonth - 1) + step;
      const targetYear = Math.floor(totalMonths / 12);
      const targetMonth = (totalMonths % 12) + 1; // 1-indexed
      const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
      const targetDay = Math.min(anchorDay || baseDay, daysInTargetMonth);
      const mm = String(targetMonth).padStart(2, "0");
      const dd = String(targetDay).padStart(2, "0");
      return `${targetYear}-${mm}-${dd}`;
    }
    case "yearly": {
      const targetYear = baseYear + step;
      const daysInTargetMonth = new Date(Date.UTC(targetYear, baseMonth, 0)).getUTCDate();
      const targetDay = Math.min(anchorDay || baseDay, daysInTargetMonth);
      const mm = String(baseMonth).padStart(2, "0");
      const dd = String(targetDay).padStart(2, "0");
      return `${targetYear}-${mm}-${dd}`;
    }
    default:
      return null;
  }
};

// Day of month a series is meant to land on, from its dates newest first. A row on the last day of its
// month may have been clamped from a later day (Jan 31 -> Feb 28), so month-end rows are skipped back to
// the first row that is not a month end, and the largest day seen wins. A series moved to the 31st keeps
// the 31st after a 30-day month; a series moved to an earlier day keeps the new day (N4).
const getSeriesAnchorDay = (datesNewestFirst) => {
  let anchor = null;
  for (const dateStr of datesNewestFirst || []) {
    const [y, m, d] = String(dateStr).split("T")[0].split("-").map(Number);
    anchor = Math.max(anchor || 0, d);
    const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d !== lastDayOfMonth) break;
  }
  return anchor;
};

// Series started from Quick Add never generated before the N1 fix: every insert copied the unique
// clientRef and failed. Without a guard, the first run after deploy would create every missed past
// month (expenses unpaid, so they look overdue). The first run stores its date here, and occurrences
// dated before it are skipped for any series whose newest row still carries a clientRef.
const QUICK_ADD_CATCHUP_KEY = "recurring_quick_add_catchup_from";

const getQuickAddCatchupFrom = async (todayStr, dbTx) => {
  try {
    const [setting] = await Setting.findOrCreate({
      where: { key: QUICK_ADD_CATCHUP_KEY },
      defaults: { value: todayStr },
      transaction: dbTx,
    });
    return setting.value;
  } catch (err) {
    // Another run created it at the same moment
    const setting = await Setting.findByPk(QUICK_ADD_CATCHUP_KEY, { transaction: dbTx });
    if (!setting) throw err;
    return setting.value;
  }
};

const ACTIVE_RECURRENCES = ["weekly", "bi-weekly", "monthly", "yearly"];

// Set once the one-off series-end migration (runSeriesEndMigration) has committed. The generator
// does not run before it: it would restart series that stopped under the old rule, with a backfill.
const SERIES_END_MIGRATION_KEY = "series_end_explicit_v1";

// A series restarted by setting one of its rows back to recurring (after it had ended) generates
// only from the restart date, so missed occurrences are not backfilled as overdue bills or as
// income already received. Stored per series as `${SERIES_RESTART_PREFIX}${recurringGroupId}`.
const SERIES_RESTART_PREFIX = "recurring_restart_from:";

const markSeriesRestart = (recurringGroupId, todayStr, dbTx = null) =>
  Setting.upsert(
    { key: `${SERIES_RESTART_PREFIX}${recurringGroupId}`, value: todayStr },
    { transaction: dbTx }
  );

const getSeriesRestarts = async (dbTx) => {
  const rows = await Setting.findAll({
    where: { key: { [Op.like]: `${SERIES_RESTART_PREFIX}%` } },
    transaction: dbTx,
  });
  return new Map(rows.map((r) => [r.key.slice(SERIES_RESTART_PREFIX.length), r.value]));
};

// Groups rows (newest first) into series, keyed by recurringGroupId or by type and title for older rows.
const getSeriesKey = (trx) =>
  trx.recurringGroupId
    ? `series:${trx.recurringGroupId}`
    : `${trx.type}:${trx.title.toLowerCase().trim()}`;

// What a series generates from, given its rows newest first. The template is the newest row that
// still recurs: a row set to One-time changes only itself, so it never stops the series (B3). Ending a
// series sets recurrence "none" on all of its rows, so a series with no recurring row left has ended
// (returns null). New occurrences come only after newestDate, the newest row of any recurrence, so a
// One-time row is never duplicated on its date. The anchor day comes from the recurring rows only, so
// a One-time row on another day does not move the series.
const getSeriesTemplate = (rowsNewestFirst) => {
  const rows = rowsNewestFirst || [];
  const index = rows.findIndex((r) => ACTIVE_RECURRENCES.includes(r.recurrence));
  if (index === -1) return null;
  const recurringDates = rows
    .slice(index)
    .filter((r) => ACTIVE_RECURRENCES.includes(r.recurrence))
    .map((r) => r.date);
  return {
    template: rows[index],
    newestDate: rows[0].date,
    anchorDay: getSeriesAnchorDay(recurringDates),
  };
};

const groupSeries = (rowsNewestFirst) => {
  const latestOccurrences = {};
  const seriesDates = {};
  const seriesRows = {};
  for (const trx of rowsNewestFirst) {
    const key = getSeriesKey(trx);
    if (!latestOccurrences[key]) {
      latestOccurrences[key] = trx;
      seriesDates[key] = [];
      seriesRows[key] = [];
    }
    seriesDates[key].push(trx.date);
    seriesRows[key].push(trx);
  }
  // Only series that are still running
  const seriesTemplates = {};
  for (const [key, rows] of Object.entries(seriesRows)) {
    const series = getSeriesTemplate(rows);
    if (series) seriesTemplates[key] = series;
  }
  return { latestOccurrences, seriesDates, seriesRows, seriesTemplates };
};

// A series whose card, debt or goal is archived (or no longer exists) stops generating
const isSeriesAccountRetired = (trx, accountsById) =>
  [trx.fromAccountId, trx.toAccountId].some(
    (id) => id && (!accountsById.has(id) || accountsById.get(id).isActive === false)
  );

const getNextDueDate = (currentDate, recurrence) => {
  if (currentDate instanceof Date) {
    const y = currentDate.getFullYear();
    const m = String(currentDate.getMonth() + 1).padStart(2, "0");
    const d = String(currentDate.getDate()).padStart(2, "0");
    currentDate = `${y}-${m}-${d}`;
  }
  return getNextOccurrenceDate(currentDate, recurrence, 1);
};

// options.todayStr overrides "today" (America/Toronto) so tests can use fixed dates.
const createRecurringExpenses = async (dbTx = null, options = {}) => {
  console.log("Running advanced timezone-aware recurring job...");
  try {
    const todayStr =
      options.todayStr ||
      format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", { timeZone: TIMEZONE });
    const migrated = await Setting.findByPk(SERIES_END_MIGRATION_KEY, { transaction: dbTx });
    if (!migrated || migrated.value !== "true") {
      console.warn(
        `Recurring job skipped: the series-end migration (${SERIES_END_MIGRATION_KEY}) has not completed.`
      );
      return;
    }
    const quickAddCatchupFrom = await getQuickAddCatchupFrom(todayStr, dbTx);
    const seriesRestarts = await getSeriesRestarts(dbTx);
    
    // Horizon is 30 calendar days from today in America/Toronto
    const [tY, tM, tD] = todayStr.split("-").map(Number);
    const horizonUtc = new Date(Date.UTC(tY, tM - 1, tD, 12, 0, 0) + 30 * 24 * 60 * 60 * 1000);
    const horizonString = `${horizonUtc.getUTCFullYear()}-${String(horizonUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(horizonUtc.getUTCDate()).padStart(2, "0")}`;

    // Fetch all INCOME, EXPENSE, and TRANSFER transactions newest first; each series generates from
    // its newest row that still recurs (see getSeriesTemplate)
    const allTransactions = await Transaction.findAll({
      where: {
        type: { [Op.in]: ["EXPENSE", "INCOME", "TRANSFER"] },
      },
      order: [
        ["date", "DESC"],
        ["createdAt", "DESC"],
      ],
      transaction: dbTx,
    });

    const { seriesTemplates } = groupSeries(allTransactions);
    const accounts = await Account.findAll({
      attributes: ["id", "isActive"],
      transaction: dbTx,
    });
    const accountsById = new Map(accounts.map((a) => [a.id, a]));

    for (const { template: baseTrx, newestDate, anchorDay } of Object.values(seriesTemplates)) {
      if (isSeriesAccountRetired(baseTrx, accountsById)) {
        continue;
      }

      const quickAddSkip =
        baseTrx.clientRef && baseTrx.date < quickAddCatchupFrom ? quickAddCatchupFrom : null;
      const restartSkip = baseTrx.recurringGroupId
        ? seriesRestarts.get(baseTrx.recurringGroupId) || null
        : null;
      const skipBefore =
        quickAddSkip && restartSkip
          ? quickAddSkip > restartSkip
            ? quickAddSkip
            : restartSkip
          : quickAddSkip || restartSkip;
      let step = 1;
      while (true) {
        const nextDateStr = getNextOccurrenceDate(
          baseTrx.date,
          baseTrx.recurrence,
          step,
          anchorDay
        );
        if (!nextDateStr || nextDateStr > horizonString) {
          break;
        }
        if ((skipBefore && nextDateStr < skipBefore) || nextDateStr <= newestDate) {
          step++;
          continue;
        }

        // When recurringGroupId is present, match strictly by recurringGroupId to avoid colliding distinct series with identical names
        const duplicateCondition = baseTrx.recurringGroupId
          ? { recurringGroupId: baseTrx.recurringGroupId }
          : { type: baseTrx.type, title: baseTrx.title };

        // A deleted occurrence (in the Trash) counts as taken: deleting a row must not bring it back
        const existing = await Transaction.findOne({
          where: {
            date: nextDateStr,
            ...duplicateCondition,
          },
          paranoid: false,
          transaction: dbTx,
        });

        if (!existing) {
          // Income is cleared once its date has arrived; expenses & transfers start unpaid (upcoming bill)
          const isCleared =
            baseTrx.type === "INCOME" ? nextDateStr <= todayStr : false;

          const baseAmountValue =
            baseTrx.baseAmount !== null && baseTrx.baseAmount !== undefined
              ? parseFloat(baseTrx.baseAmount)
              : parseFloat(baseTrx.amount);

          const isTaxExcl = Boolean(baseTrx.isTaxExclusive);
          const taxRateVal =
            baseTrx.taxRate !== null && baseTrx.taxRate !== undefined
              ? parseFloat(baseTrx.taxRate)
              : null;
          let newAmount = baseAmountValue;
          let taxApplied = false;

          if (isCleared && isTaxExcl && taxRateVal && taxRateVal > 0) {
            newAmount =
              Math.round(baseAmountValue * (1 + taxRateVal / 100) * 100) / 100;
            taxApplied = true;
          }

          let seriesId = baseTrx.recurringGroupId;
          if (!seriesId) {
            seriesId = baseTrx.id || crypto.randomUUID();
            baseTrx.recurringGroupId = seriesId;
            await baseTrx.save({ transaction: dbTx }).catch((err) =>
              console.error("Could not backfill recurringGroupId on baseTrx:", err)
            );
          }

          const createPayload = {
            ...baseTrx.get({ plain: true }),
            id: undefined,
            amount: newAmount,
            baseAmount: baseAmountValue,
            isTaxExclusive: isTaxExcl,
            taxRate: taxRateVal,
            taxApplied,
            isCleared,
            balanceApplied: false,
            date: nextDateStr,
            recurringGroupId: seriesId,
            // clientRef is unique (Quick Add idempotency); copying it made every insert fail as a "duplicate" (N1)
            clientRef: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          try {
            if (dbTx) {
              await Transaction.sequelize.transaction(
                { transaction: dbTx },
                async (nestedTx) => {
                  await Transaction.create(createPayload, {
                    transaction: nestedTx,
                  });
                }
              );
            } else {
              await Transaction.create(createPayload);
            }
            console.log(
              `Created recurring ${baseTrx.type.toLowerCase()}: ${
                baseTrx.title
              } for ${nextDateStr}`
            );
          } catch (createErr) {
            if (
              createErr.name === "SequelizeUniqueConstraintError" ||
              (createErr.original &&
                (createErr.original.code === "SQLITE_CONSTRAINT" ||
                  createErr.original.code === "23505"))
            ) {
              console.log(
                `Recurring transaction already created for group ${seriesId} on ${nextDateStr}, skipping duplicate.`
              );
            } else {
              throw createErr;
            }
          }
        }

        step++;
      }
    }
    console.log("Recurring transactions job finished.");
  } catch (error) {
    console.error("Error creating recurring transactions:", error);
    // Rethrow so cron endpoints and schedulers report the failure instead of success (B5)
    throw error;
  }
};

// One-off (guarded in server.js): before series ended explicitly, a series stopped when its newest
// row was set to One-time. The generator now looks past such a row, so those series are ended for real
// (every row "none", Trash included) instead of coming back with a backfill of missed occurrences.
// Returns the number of series ended.
const endSeriesStoppedByNewestRow = async (dbTx = null) => {
  const rows = await Transaction.findAll({
    where: { type: { [Op.in]: ["EXPENSE", "INCOME", "TRANSFER"] } },
    order: [
      ["date", "DESC"],
      ["createdAt", "DESC"],
    ],
    transaction: dbTx,
  });
  const { latestOccurrences, seriesRows } = groupSeries(rows);
  let ended = 0;
  for (const [key, newest] of Object.entries(latestOccurrences)) {
    if (ACTIVE_RECURRENCES.includes(newest.recurrence)) continue;
    const where = newest.recurringGroupId
      ? { recurringGroupId: newest.recurringGroupId }
      : { id: { [Op.in]: seriesRows[key].map((r) => r.id) } };
    const [count] = await Transaction.update(
      { recurrence: "none" },
      {
        where: { ...where, recurrence: { [Op.in]: ACTIVE_RECURRENCES } },
        paranoid: false,
        transaction: dbTx,
      }
    );
    if (count > 0) ended++;
  }
  return ended;
};

// Runs the one-off migration in one DB transaction together with its Setting flag, so a failure
// leaves both untouched (and the generator skipped) until the next boot retries it.
// Returns the number of series ended, or null when it had already run.
const runSeriesEndMigration = async (migrate = endSeriesStoppedByNewestRow) => {
  const done = await Setting.findByPk(SERIES_END_MIGRATION_KEY);
  if (done && done.value === "true") return null;
  return Transaction.sequelize.transaction(async (dbTx) => {
    const endedCount = await migrate(dbTx);
    await Setting.upsert({ key: SERIES_END_MIGRATION_KEY, value: "true" }, { transaction: dbTx });
    return endedCount;
  });
};

router.all("/trigger-recurring", cronAuthMiddleware, async (req, res) => {
  await createRecurringExpenses();
  res.status(200).json({ message: "Advanced recurring job triggered successfully." });
});

module.exports = {
  router,
  createRecurringExpenses,
  getNextDueDate,
  getNextOccurrenceDate,
  getSeriesAnchorDay,
  getSeriesTemplate,
  groupSeries,
  endSeriesStoppedByNewestRow,
  runSeriesEndMigration,
  markSeriesRestart,
  SERIES_END_MIGRATION_KEY,
  ACTIVE_RECURRENCES,
  QUICK_ADD_CATCHUP_KEY,
};
