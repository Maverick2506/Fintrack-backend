const express = require("express");
const {
  sequelize,
  Paycheque,
  Expense,
  Debt,
  SavingsGoal,
  CreditCard, // Make sure CreditCard is imported
} = require("../models");
const { Op } = require("sequelize");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/dashboard", async (req, res) => {
  try {
    const year = req.query.year
      ? parseInt(req.query.year)
      : new Date().getFullYear();
    const month = req.query.month
      ? parseInt(req.query.month) - 1
      : new Date().getMonth();
    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0);
    const today = new Date();

    const totalIncome = await Paycheque.sum("amount", {
      where: { payment_date: { [Op.between]: [startOfMonth, endOfMonth] } },
    });

    // MODIFIED: Only sum expenses that were NOT paid with a credit card for cash flow calculation
    const totalSpending = await Expense.sum("amount", {
      where: {
        due_date: { [Op.between]: [startOfMonth, endOfMonth] },
        paid_with_credit_card: false, // This ensures we only count cash/debit expenses
      },
    });

    const upcomingBills = await Expense.findAll({
      where: { is_paid: false, due_date: { [Op.gte]: today } },
      order: [["due_date", "ASC"]],
      limit: 5,
    });

    const debtSummary = await Debt.findAll();
    const savingsSummary = await SavingsGoal.findAll();
    const creditCardSummary = await CreditCard.findAll({
      include: [{ model: Expense }],
    });

    res.json({
      monthlySummary: {
        totalIncome: totalIncome || 0,
        totalSpending: totalSpending || 0,
        netFlow: (totalIncome || 0) - (totalSpending || 0),
      },
      upcomingBills,
      debtSummary,
      savingsSummary,
      creditCardSummary,
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// No changes needed for this route
router.get("/spending-summary", async (req, res) => {
  try {
    const year = req.query.year
      ? parseInt(req.query.year)
      : new Date().getFullYear();
    const month = req.query.month
      ? parseInt(req.query.month) - 1
      : new Date().getMonth();
    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0);

    const spendingByCategory = await Expense.findAll({
      attributes: [
        "category",
        [sequelize.fn("SUM", sequelize.col("amount")), "total_amount"],
      ],
      where: {
        due_date: { [Op.between]: [startOfMonth, endOfMonth] },
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

module.exports = router;
