const express = require("express");
const crypto = require("crypto");
const { Transaction, Setting, Account } = require("../models");
const { Op } = require("sequelize");
const { addDays, addMonths, addYears } = require("date-fns");
const { toZonedTime, format } = require("date-fns-tz");
const cronAuthMiddleware = require("../middleware/cronAuthMiddleware");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const {
  endSeries,
  resolveSeries,
  ACTIVE_RECURRENCES,
  SERIES_RESTART_PREFIX,
  SERIES_VACATED_PREFIX,
} = require("../services/seriesService");
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

// Set once the one-off series-end migration (runSeriesEndMigration) has committed. The generator
// does not run before it: it would restart series that stopped under the old rule, with a backfill.
const SERIES_END_MIGRATION_KEY = "series_end_explicit_v1";

// Set once runLegacySeriesIdMigration has committed. It runs before the series-end migration, and the
// generator waits for both: until then older series are still grouped by title and could be charged twice.
const LEGACY_SERIES_IDS_KEY = "legacy_series_ids_v1";
const GENERATOR_MIGRATION_KEYS = [LEGACY_SERIES_IDS_KEY, SERIES_END_MIGRATION_KEY];

// The one-off migrations the generator still waits for (empty once both have run)
const getPendingMigrations = async (dbTx = null) => {
  const done = await Setting.findAll({
    where: { key: GENERATOR_MIGRATION_KEYS, value: "true" },
    transaction: dbTx,
  });
  const doneKeys = new Set(done.map((s) => s.key));
  return GENERATOR_MIGRATION_KEYS.filter((key) => !doneKeys.has(key));
};

const skippedMessage = (pending) =>
  `Recurring job skipped: the one-off migration${pending.length > 1 ? "s" : ""} (${pending.join(", ")}) ${
    pending.length > 1 ? "have" : "has"
  } not completed.`;

// A series restarted by setting one of its rows back to recurring (after it had ended) generates
// only from the restart date, so missed occurrences are not backfilled as overdue bills or as
// income already received. Stored per series as `${SERIES_RESTART_PREFIX}${recurringGroupId}`.
const markSeriesRestart = (recurringGroupId, todayStr, dbTx = null) =>
  Setting.upsert(
    { key: `${SERIES_RESTART_PREFIX}${recurringGroupId}`, value: todayStr },
    { transaction: dbTx }
  );

// The slot a moved series row left stays taken: moving the newest row earlier (Nov 21 to Nov 19,
// set to One-time) must not let the generator charge Nov 21 again. Stored per series as
// `${SERIES_VACATED_PREFIX}${groupId}` = JSON { rowId: the date that row first held }. Only the
// exact original date is kept, and moving the row back onto it clears it, so correcting a mistyped
// date never hides other occurrences. endSeries removes the Setting; otherwise it is one small row
// per series with a moved row.
const markSeriesRowMoved = async (recurringGroupId, rowId, fromDate, toDate, dbTx = null) => {
  const key = `${SERIES_VACATED_PREFIX}${recurringGroupId}`;
  const existing = await Setting.findByPk(key, { transaction: dbTx });
  let slots = {};
  try {
    slots = existing ? JSON.parse(existing.value) || {} : {};
  } catch {
    slots = {};
  }
  const original = slots[rowId] || fromDate;
  if (toDate === original) delete slots[rowId];
  else slots[rowId] = original;
  if (Object.keys(slots).length === 0) {
    if (existing) await existing.destroy({ transaction: dbTx });
    return;
  }
  await Setting.upsert({ key, value: JSON.stringify(slots) }, { transaction: dbTx });
};

const getSettingsByPrefix = async (prefix, dbTx) => {
  const rows = await Setting.findAll({
    where: { key: { [Op.like]: `${prefix}%` } },
    transaction: dbTx,
  });
  return new Map(rows.map((r) => [r.key.slice(prefix.length), r.value]));
};

const getSeriesRestarts = (dbTx) => getSettingsByPrefix(SERIES_RESTART_PREFIX, dbTx);

// Per series: the set of slot dates moved rows left (see markSeriesRowMoved). The generator and the
// forecast skip them.
const getSeriesVacatedDates = async (dbTx) => {
  const raw = await getSettingsByPrefix(SERIES_VACATED_PREFIX, dbTx);
  const byGroup = new Map();
  for (const [groupId, value] of raw) {
    try {
      byGroup.set(groupId, new Set(Object.values(JSON.parse(value) || {})));
    } catch {
      // A bad value skips nothing
    }
  }
  return byGroup;
};

const latestOf = (...dates) =>
  dates.filter(Boolean).reduce((max, d) => (!max || d > max ? d : max), null);

// Groups rows (newest first) into series by recurringGroupId. A row without one is a single row, not a
// series: every recurring row gets an id when saved (models/transaction.js), and older series got
// theirs from the legacy_series_ids_v1 migration (assignLegacySeriesIds).
const getSeriesKey = (trx) =>
  trx.recurringGroupId ? `series:${trx.recurringGroupId}` : `row:${trx.id}`;

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
    const pending = await getPendingMigrations(dbTx);
    if (pending.length > 0) {
      console.warn(skippedMessage(pending));
      return { skipped: true, pending };
    }
    const quickAddCatchupFrom = await getQuickAddCatchupFrom(todayStr, dbTx);
    const seriesRestarts = await getSeriesRestarts(dbTx);
    const seriesVacated = await getSeriesVacatedDates(dbTx);
    
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
      const vacated = seriesVacated.get(baseTrx.recurringGroupId);

      const quickAddSkip =
        baseTrx.clientRef && baseTrx.date < quickAddCatchupFrom ? quickAddCatchupFrom : null;
      const restartSkip = baseTrx.recurringGroupId
        ? seriesRestarts.get(baseTrx.recurringGroupId) || null
        : null;
      const skipBefore = latestOf(quickAddSkip, restartSkip);
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
        if ((skipBefore && nextDateStr < skipBefore) || nextDateStr <= newestDate || vacated?.has(nextDateStr)) {
          step++;
          continue;
        }

        // Match strictly by series id, so distinct series with identical names never collide. A
        // recurring row saved without one becomes a series under its own id below.
        // A deleted occurrence (in the Trash) counts as taken: deleting a row must not bring it back
        const existing = await Transaction.findOne({
          where: {
            date: nextDateStr,
            recurringGroupId: baseTrx.recurringGroupId || baseTrx.id,
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
// Loads every transaction into memory, which is fine for a one-off at this app's size.
// Returns the titles of the series it ended.
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
  const endedTitles = [];
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
    if (count > 0) endedTitles.push(newest.title);
  }
  return endedTitles;
};

// Runs the one-off migration in one DB transaction together with its Setting flag, so a failure
// leaves both untouched (and the generator skipped) until the next boot retries it.
// Returns the titles of the series it ended, or null when it had already run.
const runSeriesEndMigration = async (migrate = endSeriesStoppedByNewestRow) => {
  const done = await Setting.findByPk(SERIES_END_MIGRATION_KEY);
  if (done && done.value === "true") return null;
  return Transaction.sequelize.transaction(async (dbTx) => {
    const endedTitles = await migrate(dbTx);
    await Setting.upsert({ key: SERIES_END_MIGRATION_KEY, value: "true" }, { transaction: dbTx });
    return endedTitles;
  });
};

// The type and title older rows (no recurringGroupId) were grouped by before legacy_series_ids_v1
const legacySeriesKey = (trx) => `${trx.type}:${String(trx.title || "").toLowerCase().trim()}`;

// One-off (guarded in server.js): older series had no recurringGroupId and were grouped by type and
// title, so no vacated slot was kept for them and a newest row moved earlier could be charged twice.
// Every such title group with at least one recurring row (Trash included) gets a series id on all of its
// rows, Trash included; groups that never recurred are left alone. Grouping ignores the account, as the
// old title grouping did.
// Before this, the generator and edits gave some rows of an old series an id (the template row's own
// id, or a fresh one) while its older rows kept none. Such a group joins the existing id of the same
// type and title (the series with the newest row, if several), as legacy_recurring_groups_backfilled
// did; a new id would make a second series that the generator fills in on every date.
// Only one row per date can hold an id (unique index on recurringGroupId + date). Rows on a date the
// joined series already has are left out; among rows without an id on one date, the one that joins is,
// in order, the recurring one, then the paid one, then the oldest (createdAt). A left-out row that still
// recurs is set to One-time, or it would generate as a series of its own and be charged twice.
// Loads the rows into memory, which is fine for a one-off at this app's size.
// Returns { seriesCount, joinedExistingCount, rowCount, leftOut: [{ title, date, amount, setToOneTime }] }.
const assignLegacySeriesIds = async (dbTx = null) => {
  const rows = await Transaction.findAll({
    where: { recurringGroupId: null },
    order: [["date", "ASC"]],
    paranoid: false,
    transaction: dbTx,
  });
  const groups = new Map();
  for (const row of rows) {
    const key = legacySeriesKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Per type and title: the existing series with the newest row, and the dates it holds
  const withId = await Transaction.findAll({
    where: { recurringGroupId: { [Op.ne]: null } },
    attributes: ["id", "title", "type", "date", "recurringGroupId"],
    order: [
      ["date", "DESC"],
      ["createdAt", "DESC"],
    ],
    paranoid: false,
    transaction: dbTx,
  });
  const existingIdByKey = new Map();
  const datesById = new Map();
  for (const row of withId) {
    const key = legacySeriesKey(row);
    if (!existingIdByKey.has(key)) existingIdByKey.set(key, row.recurringGroupId);
    if (!datesById.has(row.recurringGroupId)) datesById.set(row.recurringGroupId, new Set());
    datesById.get(row.recurringGroupId).add(row.date);
  }

  const joinsFirst = (a, b) =>
    Number(ACTIVE_RECURRENCES.includes(b.recurrence)) - Number(ACTIVE_RECURRENCES.includes(a.recurrence)) ||
    Number(Boolean(b.isCleared)) - Number(Boolean(a.isCleared)) ||
    new Date(a.createdAt) - new Date(b.createdAt) ||
    String(a.id).localeCompare(String(b.id));
  const result = { seriesCount: 0, joinedExistingCount: 0, rowCount: 0, leftOut: [] };
  for (const [key, groupRows] of groups) {
    if (!groupRows.some((r) => ACTIVE_RECURRENCES.includes(r.recurrence))) continue;
    const existingId = existingIdByKey.get(key) || null;
    const takenDates = (existingId && datesById.get(existingId)) || new Set();
    const byDate = new Map();
    for (const row of groupRows) {
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date).push(row);
    }
    const ids = [];
    const stopIds = [];
    for (const [date, sameDate] of byDate) {
      const sorted = [...sameDate].sort(joinsFirst);
      const excluded = takenDates.has(date) ? sorted : sorted.slice(1);
      if (!takenDates.has(date)) ids.push(sorted[0].id);
      for (const r of excluded) {
        const setToOneTime = ACTIVE_RECURRENCES.includes(r.recurrence);
        if (setToOneTime) stopIds.push(r.id);
        result.leftOut.push({ title: r.title, date: r.date, amount: parseFloat(r.amount) || 0, setToOneTime });
      }
    }
    if (ids.length > 0) {
      await Transaction.update(
        { recurringGroupId: existingId || crypto.randomUUID() },
        { where: { id: { [Op.in]: ids } }, paranoid: false, transaction: dbTx }
      );
    }
    if (stopIds.length > 0) {
      await Transaction.update(
        { recurrence: "none" },
        { where: { id: { [Op.in]: stopIds } }, paranoid: false, transaction: dbTx }
      );
    }
    result.seriesCount++;
    if (existingId) result.joinedExistingCount++;
    result.rowCount += ids.length;
  }
  return result;
};

// Runs the one-off in one DB transaction together with its Setting flag, like runSeriesEndMigration.
// Returns assignLegacySeriesIds' result, or null when it had already run.
const runLegacySeriesIdMigration = async (migrate = assignLegacySeriesIds) => {
  const done = await Setting.findByPk(LEGACY_SERIES_IDS_KEY);
  if (done && done.value === "true") return null;
  return Transaction.sequelize.transaction(async (dbTx) => {
    const result = await migrate(dbTx);
    await Setting.upsert({ key: LEGACY_SERIES_IDS_KEY, value: "true" }, { transaction: dbTx });
    return result;
  });
};

router.all("/trigger-recurring", cronAuthMiddleware, async (req, res) => {
  const result = await createRecurringExpenses();
  if (result?.skipped) {
    // Not a success: the cron log should show that nothing was generated
    return res.status(503).json({ skipped: true, error: skippedMessage(result.pending) });
  }
  res.status(200).json({ message: "Advanced recurring job triggered successfully." });
});

// POST /api/recurring/:recurringGroupId/end { dryRun? } ends any series: expense, income or transfer.
// The id may also be a row id of an older series without a group id. Returns { seriesEnded,
// removedUpcomingCount, removedUpcomingTotal }; with dryRun it only reports.
router.post(
  "/:recurringGroupId/end",
  authMiddleware,
  (req, res, next) => validateIdParam(req, res, next, req.params.recurringGroupId),
  validateBody(schemas.endSeries),
  asyncHandler(async (req, res) => {
    const dryRun = req.body.dryRun === true;
    const dbTx = await Transaction.sequelize.transaction();
    let result;
    try {
      const series = await resolveSeries(req.params.recurringGroupId, dbTx);
      if (!series) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Recurring series not found." });
      }
      result = await endSeries(series, { dryRun, dbTx });
      await dbTx.commit();
    } catch (err) {
      if (!dbTx.finished) await dbTx.rollback();
      throw err;
    }
    const { keptCount, ...body } = result;
    res.json({ ...body, dryRun });
  })
);

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
  assignLegacySeriesIds,
  runLegacySeriesIdMigration,
  markSeriesRestart,
  markSeriesRowMoved,
  getSeriesVacatedDates,
  SERIES_END_MIGRATION_KEY,
  LEGACY_SERIES_IDS_KEY,
  ACTIVE_RECURRENCES,
  QUICK_ADD_CATCHUP_KEY,
};
