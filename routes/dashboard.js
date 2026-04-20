const express = require("express");
const {
  sequelize,
  Account,
  Transaction,
} = require("../models");
const { Op } = require("sequelize");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/dashboard", async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) - 1 : new Date().getMonth();
    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0);
    const today = new Date();

    const startOfPreviousMonth = new Date(year, month - 1, 1);
    const endOfPreviousMonth = new Date(year, month, 0);

    const previousMonthIncome = await Transaction.sum("amount", {
      where: { type: "INCOME", date: { [Op.between]: [startOfPreviousMonth, endOfPreviousMonth] } }
    });

    const previousMonthSpending = await Transaction.sum("amount", {
      where: { type: "EXPENSE", date: { [Op.between]: [startOfPreviousMonth, endOfPreviousMonth] } }
    });

    const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
    const cashFlowEndOfMonth = isCurrentMonth ? today : endOfMonth;

    const totalIncome = await Transaction.sum("amount", {
      where: { type: "INCOME", date: { [Op.between]: [startOfMonth, cashFlowEndOfMonth] } }
    });

    const totalSpending = await Transaction.sum("amount", {
      where: { type: "EXPENSE", date: { [Op.between]: [startOfMonth, cashFlowEndOfMonth] } }
    });

    const upcomingBills = await Transaction.findAll({
      where: { type: "EXPENSE", isCleared: false, date: { [Op.gte]: today } },
      order: [["date", "ASC"]],
      limit: 5,
    });

    const allUpcomingBills = await Transaction.findAll({
      where: {
        type: "EXPENSE", isCleared: false,
        date: { [Op.between]: [today, endOfMonth] },
      },
      order: [["date", "ASC"]],
    });

    const debtSummary = await Account.findAll({ where: { type: "DEBT" } });
    const savingsSummary = await Account.findAll({ where: { type: "SAVINGS_GOAL" } });
    const creditCardSummary = await Account.findAll({
      where: { type: "CREDIT_CARD" },
      include: [{ model: Transaction, as: "outgoingTransactions" }], 
    });

    res.json({
      monthlySummary: {
        totalIncome: totalIncome || 0,
        totalSpending: totalSpending || 0,
        netFlow: (totalIncome || 0) - (totalSpending || 0),
        previousMonthNetFlow: (previousMonthIncome || 0) - (previousMonthSpending || 0),
      },
      upcomingBills,
      allUpcomingBills,
      debtSummary,
      savingsSummary,
      creditCardSummary,
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/spending-summary", async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) - 1 : new Date().getMonth();
    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0);

    const spendingByCategory = await Transaction.findAll({
      attributes: [
        "category",
        [sequelize.fn("SUM", sequelize.col("amount")), "total_amount"],
      ],
      where: {
        type: "EXPENSE",
        date: { [Op.between]: [startOfMonth, endOfMonth] },
      },
      group: ["category"],
      raw: true,
    });
    
    const formattedData = spendingByCategory.map((item) => ({
      name: item.category,
      value: parseFloat(item.total_amount),
    }));
    res.json(formattedData);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch spending summary." });
  }
});

router.get("/trends", async (req, res) => {
  try {
    const trends = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0);

      const income = await Transaction.sum("amount", {
        where: { type: "INCOME", date: { [Op.between]: [startOfMonth, endOfMonth] } },
      });

      const spending = await Transaction.sum("amount", {
        where: { type: "EXPENSE", date: { [Op.between]: [startOfMonth, endOfMonth] } },
      });

      trends.push({
        name: d.toLocaleString("default", { month: "short" }),
        income: income || 0,
        spending: spending || 0,
      });
    }
    res.json(trends);
  } catch (error) {
    console.error("Error fetching trends:", error);
    res.status(500).json({ error: "Failed to fetch trends data." });
  }
});

module.exports = router;
