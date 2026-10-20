const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { sequelize, Budget, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime } = require("date-fns-tz");

const router = express.Router();
router.use(authMiddleware);

const TIMEZONE = "America/Toronto";

// GET /api/budgets
// Returns all configured category budgets, with rollover computed
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const budgets = await Budget.findAll({ order: [["category", "ASC"]] });

    // Determine target month for rollover calculation
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    let targetYear = nowZoned.getFullYear();
    let targetMonth = nowZoned.getMonth() + 1; // 1-12

    if (req.query.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)) {
      const [y, m] = req.query.month.split("-").map(Number);
      targetYear = y;
      targetMonth = m;
    }

    // Prior month range
    const prevMonthDate = new Date(targetYear, targetMonth - 2, 1);
    const prevYear = prevMonthDate.getFullYear();
    const prevMonth = prevMonthDate.getMonth() + 1;
    const prevMonthStart = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
    const lastDayPrevMonth = new Date(prevYear, prevMonth, 0).getDate();
    const prevMonthEnd = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(lastDayPrevMonth).padStart(2, "0")}`;

    // Get spending for previous month for rollover calculations
    const prevSpending = await Transaction.findAll({
      attributes: ["category", [sequelize.fn("SUM", sequelize.col("amount")), "totalSpent"]],
      where: {
        type: "EXPENSE",
        isCleared: true,
        date: { [Op.between]: [prevMonthStart, prevMonthEnd] },
      },
      group: ["category"],
      raw: true,
    });

    const prevSpendingMap = {};
    for (const row of prevSpending) {
      prevSpendingMap[row.category] = parseFloat(row.totalSpent || 0);
    }

    const payload = budgets.map((b) => {
      const monthlyLimit = parseFloat(b.monthlyLimit);
      let available = monthlyLimit;
      if (b.rollover) {
        const lastMonthSpent = prevSpendingMap[b.category] || 0;
        const diff = monthlyLimit - lastMonthSpent;
        available = Math.max(0, monthlyLimit + diff);
      }
      return {
        id: b.id,
        category: b.category,
        monthlyLimit,
        rollover: Boolean(b.rollover),
        available: parseFloat(available.toFixed(2)),
      };
    });

    res.json(payload);
  })
);

// PUT /api/budgets/:category (upsert)
router.put(
  "/:category",
  validateBody(schemas.setBudget),
  asyncHandler(async (req, res) => {
    const category = decodeURIComponent(req.params.category).trim();
    if (!category || category.length > 100) {
      return res.status(400).json({ error: "Category name must be between 1 and 100 characters." });
    }

    const monthlyLimit = parseFloat(req.body.monthlyLimit ?? req.body.limit);
    let budget = await Budget.findOne({ where: { category } });
    const rollover = req.body.rollover !== undefined ? Boolean(req.body.rollover) : (budget ? budget.rollover : false);
    if (budget) {
      budget.monthlyLimit = monthlyLimit;
      budget.rollover = rollover;
      await budget.save();
    } else {
      budget = await Budget.create({
        category,
        monthlyLimit,
        rollover,
      });
    }

    res.status(200).json({
      id: budget.id,
      category: budget.category,
      monthlyLimit: parseFloat(budget.monthlyLimit),
      rollover: Boolean(budget.rollover),
      available: parseFloat(budget.monthlyLimit),
    });
  })
);

// DELETE /api/budgets/:category
router.delete(
  "/:category",
  asyncHandler(async (req, res) => {
    const category = decodeURIComponent(req.params.category).trim();
    const budget = await Budget.findOne({ where: { category } });
    if (!budget) {
      return res.status(404).json({ error: `Budget for category "${category}" not found.` });
    }

    await budget.destroy();
    res.status(204).end();
  })
);

module.exports = router;
