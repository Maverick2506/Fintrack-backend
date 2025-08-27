const express = require("express");
// Make sure to import the CreditCard model
const { Expense, Debt, CreditCard } = require("../models");
const { Op } = require("sequelize");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

// No changes needed for this route
router.get("/expenses/monthly", async (req, res) => {
  try {
    const { year, month } = req.query;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const expenses = await Expense.findAll({
      where: {
        due_date: {
          [Op.between]: [startDate, endDate],
        },
      },
      order: [["due_date", "ASC"]],
    });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- NEW ROUTE for fetching expenses by category ---
router.get("/expenses/category", async (req, res) => {
  try {
    const { year, month, category } = req.query;
    if (!year || !month || !category) {
      return res
        .status(400)
        .json({ error: "Year, month, and category are required." });
    }

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const expenses = await Expense.findAll({
      where: {
        category: category,
        due_date: {
          [Op.between]: [startDate, endDate],
        },
      },
      order: [["due_date", "ASC"]],
    });
    res.json(expenses);
  } catch (error) {
    console.error("Error fetching expenses by category:", error);
    res.status(500).json({ error: error.message });
  }
});

// MODIFIED: This route now updates the credit card balance when an expense is created
router.post("/expenses", async (req, res) => {
  try {
    const { amount, creditCardId } = req.body;
    const newExpense = await Expense.create(req.body);

    // If a creditCardId is provided, find the card and increase its balance
    if (creditCardId) {
      const card = await CreditCard.findByPk(creditCardId);
      if (card) {
        card.currentBalance =
          parseFloat(card.currentBalance) + parseFloat(amount);
        await card.save();
      }
    }

    res.status(201).json(newExpense);
  } catch (error) {
    console.error("Error creating expense:", error);
    res.status(400).json({ error: error.message });
  }
});

// No changes needed for this route
router.put("/expenses/:id", async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (expense) {
      await expense.update(req.body);
      res.json(expense);
    } else {
      res.status(404).send("Expense not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// MODIFIED: This route now reverts the balance change if a credit card expense is deleted
router.delete("/expenses/:id", async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (expense) {
      // If the deleted expense was on a credit card, find the card and decrease its balance
      if (expense.creditCardId) {
        const card = await CreditCard.findByPk(expense.creditCardId);
        if (card) {
          card.currentBalance =
            parseFloat(card.currentBalance) - parseFloat(expense.amount);
          await card.save();
        }
      }

      await expense.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Expense not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
