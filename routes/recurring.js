const express = require("express");
const crypto = require("crypto");
const { Transaction } = require("../models");
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

// Day of month a series is meant to land on. The newest row's day is used, unless that row sits on the
// last day of its month and an earlier row of the series has a later day, i.e. the newest date was
// clamped to a short month. A user who moved the series to another day keeps the new day.
const getSeriesAnchorDay = (newestDateStr, earliestDateStr) => {
  if (!newestDateStr) return null;
  const [y, m, d] = String(newestDateStr).split("T")[0].split("-").map(Number);
  if (!earliestDateStr) return d;
  const earliestDay = Number(String(earliestDateStr).split("T")[0].split("-")[2]);
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d === lastDayOfMonth && earliestDay > d ? earliestDay : d;
};

const getNextDueDate = (currentDate, recurrence) => {
  if (currentDate instanceof Date) {
    const y = currentDate.getFullYear();
    const m = String(currentDate.getMonth() + 1).padStart(2, "0");
    const d = String(currentDate.getDate()).padStart(2, "0");
    currentDate = `${y}-${m}-${d}`;
  }
  return getNextOccurrenceDate(currentDate, recurrence, 1);
};

const createRecurringExpenses = async (dbTx = null) => {
  console.log("Running advanced timezone-aware recurring job...");
  try {
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
    
    // Horizon is 30 calendar days from today in America/Toronto
    const [tY, tM, tD] = todayStr.split("-").map(Number);
    const horizonUtc = new Date(Date.UTC(tY, tM - 1, tD, 12, 0, 0) + 30 * 24 * 60 * 60 * 1000);
    const horizonString = `${horizonUtc.getUTCFullYear()}-${String(horizonUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(horizonUtc.getUTCDate()).padStart(2, "0")}`;

    // Fetch all INCOME, EXPENSE, and TRANSFER transactions ordered newest first so that
    // if the latest instance of a series was changed to recurrence: "none",
    // we respect that and do not resurrect it from an older historical row.
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

    const latestOccurrences = {};
    const earliestDates = {};
    for (const trx of allTransactions) {
      const key = trx.recurringGroupId
        ? `series:${trx.recurringGroupId}`
        : `${trx.type}:${trx.title.toLowerCase().trim()}`;
      if (!latestOccurrences[key]) {
        latestOccurrences[key] = trx;
      }
      // Rows are newest first, so the last one seen is the earliest
      earliestDates[key] = trx.date;
    }

    for (const [seriesKey, baseTrx] of Object.entries(latestOccurrences)) {
      if (
        !baseTrx.recurrence ||
        !["weekly", "bi-weekly", "monthly", "yearly"].includes(
          baseTrx.recurrence
        )
      ) {
        continue;
      }

      const anchorDay = getSeriesAnchorDay(baseTrx.date, earliestDates[seriesKey]);
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

        // When recurringGroupId is present, match strictly by recurringGroupId to avoid colliding distinct series with identical names
        const duplicateCondition = baseTrx.recurringGroupId
          ? { recurringGroupId: baseTrx.recurringGroupId }
          : { type: baseTrx.type, title: baseTrx.title };

        const existing = await Transaction.findOne({
          where: {
            date: nextDateStr,
            ...duplicateCondition,
          },
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
};
