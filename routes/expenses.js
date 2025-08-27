const express = require("express");
const { Expense, CreditCard, Debt } = require("../models"); // Make sure to import CreditCard
const { Op } = require("sequelize");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

// This route remains the same
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

// MODIFIED: Logic to update credit card balance on creation
router.post("/expenses", async (req, res) => {
  try {
    const { amount, creditCardId } = req.body;
    const newExpense = await Expense.create(req.body);

    // If a credit card was used, find it and increase its balance
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

// This route remains the same
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

// MODIFIED: Logic to revert credit card balance on deletion
router.delete("/expenses/:id", async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (expense) {
      // If the deleted expense was on a credit card, revert the balance change
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
