const express = require("express");
const { Transaction } = require("../models");
const { Op } = require("sequelize");
const { addDays, addMonths, addYears } = require("date-fns");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

const TIMEZONE = "America/Toronto";

const getNextDueDate = (currentDate, recurrence) => {
  switch (recurrence) {
    case "weekly":
      return addDays(currentDate, 7);
    case "bi-weekly":
      return addDays(currentDate, 14);
    case "monthly":
      return addMonths(currentDate, 1);
    case "yearly":
      return addYears(currentDate, 1);
    default:
      return null;
  }
};

const createRecurringExpenses = async () => {
  console.log("Running advanced timezone-aware recurring job...");
  try {
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
    const lookupHorizon = addDays(nowZoned, 30);
    const horizonString = format(lookupHorizon, "yyyy-MM-dd", {
      timeZone: TIMEZONE,
    });

    // Fetch all INCOME and EXPENSE transactions ordered newest first so that
    // if the latest instance of a series was changed to recurrence: "none",
    // we respect that and do not resurrect it from an older historical row.
    const allTransactions = await Transaction.findAll({
      where: {
        type: { [Op.in]: ["EXPENSE", "INCOME"] },
      },
      order: [
        ["date", "DESC"],
        ["createdAt", "DESC"],
      ],
    });

    const latestOccurrences = {};
    for (const trx of allTransactions) {
      const key = `${trx.type}:${trx.title.toLowerCase().trim()}`;
      if (!latestOccurrences[key]) {
        latestOccurrences[key] = trx;
      }
    }

    for (const baseTrx of Object.values(latestOccurrences)) {
      if (
        !baseTrx.recurrence ||
        !["weekly", "bi-weekly", "monthly", "yearly"].includes(
          baseTrx.recurrence
        )
      ) {
        continue;
      }

      let nextDate = toZonedTime(`${baseTrx.date}T00:00:00`, TIMEZONE);

      while (true) {
        nextDate = getNextDueDate(nextDate, baseTrx.recurrence);
        if (!nextDate) break;

        const nextDateStr = format(nextDate, "yyyy-MM-dd", {
          timeZone: TIMEZONE,
        });

        if (nextDateStr > horizonString) {
          break;
        }

        const existing = await Transaction.findOne({
          where: {
            type: baseTrx.type,
            title: baseTrx.title,
            date: nextDateStr,
          },
        });

        if (!existing) {
          // Income is cleared once its date has arrived; expenses start unpaid (upcoming bill)
          const isCleared =
            baseTrx.type === "INCOME" ? nextDateStr <= todayStr : false;

          await Transaction.create({
            ...baseTrx.get({ plain: true }),
            id: undefined,
            isCleared,
            date: nextDateStr,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          console.log(
            `Created recurring ${baseTrx.type.toLowerCase()}: ${
              baseTrx.title
            } for ${nextDateStr}`
          );
        }
      }
    }
    console.log("Recurring transactions job finished.");
  } catch (error) {
    console.error("Error creating recurring transactions:", error);
  }
};

router.post("/trigger-recurring", authMiddleware, async (req, res) => {
  await createRecurringExpenses();
  res.status(200).send("Advanced recurring job triggered successfully.");
});

module.exports = { router, createRecurringExpenses, getNextDueDate };
