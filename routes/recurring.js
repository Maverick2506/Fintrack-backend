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
    // Get absolute current date in Toronto
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    // Generate up to 30 days ahead
    const lookupHorizon = addDays(nowZoned, 30);
    // Format to strictly YYYY-MM-DD
    const horizonString = format(lookupHorizon, "yyyy-MM-dd", { timeZone: TIMEZONE });

    const allRecurring = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        recurrence: {
          [Op.in]: ["weekly", "bi-weekly", "monthly", "yearly"],
        },
      },
      order: [["date", "DESC"]],
    });

    const latestOccurrences = {};
    for (const expense of allRecurring) {
      const key = expense.title.toLowerCase().trim();
      if (!latestOccurrences[key]) {
        latestOccurrences[key] = expense;
      }
    }

    for (const baseExpense of Object.values(latestOccurrences)) {
      // Parse YYYY-MM-DD string exactly as midnight in Toronto
      let nextDate = toZonedTime(`${baseExpense.date}T00:00:00`, TIMEZONE);
      
      while (true) {
        nextDate = getNextDueDate(nextDate, baseExpense.recurrence);
        if (!nextDate) break;

        const nextDateStr = format(nextDate, "yyyy-MM-dd", { timeZone: TIMEZONE });

        if (nextDateStr > horizonString) {
           break;
        }

        const existing = await Transaction.findOne({
          where: {
            type: "EXPENSE",
            title: baseExpense.title,
            date: nextDateStr,
          },
        });

        if (!existing) {
          await Transaction.create({
            ...baseExpense.get({ plain: true }),
            id: undefined, 
            isCleared: false,
            date: nextDateStr,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          console.log(`Created recurring expense: ${baseExpense.title} for ${nextDateStr}`);
        }
      }
    }
    console.log("Recurring expenses job finished.");
  } catch (error) {
    console.error("Error creating recurring expenses:", error);
  }
};

router.post("/trigger-recurring", authMiddleware, async (req, res) => {
  await createRecurringExpenses();
  res.status(200).send("Advanced recurring job triggered successfully.");
});

module.exports = { router, createRecurringExpenses };
