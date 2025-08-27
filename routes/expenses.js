const express = require("express");
const { Expense, Debt } = require("../models");
const { Op } = require("sequelize");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

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

router.post("/expenses", async (req, res) => {
  try {
    const { name, amount, category } = req.body;
    let is_paid = false;

    if (category === "Debt") {
      const debt = await Debt.findOne({
        where: { name: name.replace("Payment for ", "") },
      });
      if (debt) {
        debt.total_remaining =
          parseFloat(debt.total_remaining) - parseFloat(amount);
        await debt.save();
        is_paid = true;
      }
    }

    const newExpense = await Expense.create({ ...req.body, is_paid });
    res.status(201).json(newExpense);
  } catch (error) {
    console.error("Error creating expense:", error);
    res.status(400).json({ error: error.message });
  }
});

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

router.delete("/expenses/:id", async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (expense) {
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
