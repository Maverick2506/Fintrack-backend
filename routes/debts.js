const express = require("express");
const { Debt, Expense } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/debts", async (req, res) => {
  try {
    const debts = await Debt.findAll();
    res.json(debts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/debts", async (req, res) => {
  try {
    const { name, total_amount, monthly_payment } = req.body;
    const newDebt = await Debt.create({
      name,
      total_amount,
      total_remaining: total_amount,
      monthly_payment,
    });
    res.status(201).json(newDebt);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/debts/:id/pay", async (req, res) => {
  try {
    const debt = await Debt.findByPk(req.params.id);
    if (debt) {
      const paymentAmount = parseFloat(req.body.amount);
      debt.total_remaining = parseFloat(debt.total_remaining) - paymentAmount;
      await debt.save();

      await Expense.create({
        name: `Payment for ${debt.name}`,
        amount: paymentAmount,
        due_date: new Date(),
        is_paid: true,
        category: "Debt",
      });

      res.json(debt);
    } else {
      res.status(404).send("Debt not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/debts/:id", async (req, res) => {
  try {
    const debt = await Debt.findByPk(req.params.id);
    if (debt) {
      await debt.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Debt not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
