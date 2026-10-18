const express = require("express");
const { Transaction, Account } = require("../models");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { createRecurringExpenses } = require("./recurring");
const router = express.Router();

router.use(authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

router.get(
  "/paycheques",
  asyncHandler(async (req, res) => {
    const incomes = await Transaction.findAll({
      where: { type: "INCOME" },
      order: [["date", "ASC"]],
    });

    const formatted = incomes.map((i) => ({
      ...i.toJSON(),
      name: i.title,
      payment_date: i.date,
    }));
    res.json(formatted);
  })
);

router.post(
  "/paycheques",
  validateBody(schemas.createPaycheque),
  asyncHandler(async (req, res) => {
    const { name, amount, payment_date, recurrence } = req.body;
    const [checking] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
    });

    const todayStr = getTodayString();
    // Only mark income cleared if its payment date has arrived
    const isCleared = payment_date <= todayStr;

    const newIncome = await Transaction.create({
      title: name,
      amount: parseFloat(amount),
      date: payment_date,
      type: "INCOME",
      category: "Income",
      isCleared,
      toAccountId: checking ? checking.id : null,
      recurrence: recurrence || "none",
    });

    res.status(201).json({
      ...newIncome.toJSON(),
      name: newIncome.title,
      payment_date: newIncome.date,
    });

    if (recurrence && recurrence !== "none") {
      createRecurringExpenses().catch((err) =>
        console.error("Background recurring generation error:", err)
      );
    }
  })
);

router.delete(
  "/paycheques/:id",
  asyncHandler(async (req, res) => {
    // Restrict deletion strictly to INCOME rows to avoid bypassing balance adjustments on other types
    const trx = await Transaction.findOne({
      where: { id: req.params.id, type: "INCOME" },
    });
    if (trx) {
      await trx.destroy();
      res.status(204).send();
    } else {
      res.status(404).json({ error: "Income transaction not found" });
    }
  })
);

module.exports = router;
