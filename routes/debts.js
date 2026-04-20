const express = require("express");
const { Account, Transaction } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/debts", async (req, res) => {
  try {
    const debts = await Account.findAll({ where: { type: "DEBT" } });
    const formatted = debts.map(d => ({
      ...d.toJSON(),
      total_amount: d.targetAmount || d.initialBalance, 
      total_remaining: d.initialBalance,
      monthly_payment: d.minimumPayment,
      next_due_date: d.dueDate
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/debts", async (req, res) => {
  try {
    const { name, total_amount, monthly_payment, auto_pay, next_due_date, payment_frequency } = req.body;
    const newDebt = await Account.create({
      name,
      type: "DEBT",
      initialBalance: total_amount,
      targetAmount: total_amount,
      minimumPayment: monthly_payment,
      dueDate: next_due_date || null,
    });
    // Respond in frontend's expected format
    res.status(201).json({
      ...newDebt.toJSON(),
      total_amount: newDebt.targetAmount,
      total_remaining: newDebt.initialBalance,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/debts/:id/pay", async (req, res) => {
  try {
    const debt = await Account.findByPk(req.params.id);
    const checking = await Account.findOne({ where: { name: "Primary Checking" } });

    if (debt && checking) {
      const paymentAmount = parseFloat(req.body.amount);
      debt.initialBalance = parseFloat(debt.initialBalance) - paymentAmount;
      await debt.save();

      // **CREATE TRANSFER RECORD**
      await Transaction.create({
        title: `Payment for ${debt.name}`,
        amount: paymentAmount,
        date: new Date(),
        type: "TRANSFER",
        category: "Debt Payment",
        isCleared: true,
        fromAccountId: checking.id,
        toAccountId: debt.id,
      });

      res.json({
        ...debt.toJSON(),
        total_remaining: debt.initialBalance,
      });
    } else {
      res.status(404).send("Debt or Checking Account not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/debts/:id", async (req, res) => {
  try {
    const debt = await Account.findByPk(req.params.id);
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

router.put("/debts/:id", async (req, res) => {
  try {
    const debt = await Account.findByPk(req.params.id);
    if (debt) {
      const { name, total_amount, monthly_payment, auto_pay, next_due_date, payment_frequency } = req.body;
      await debt.update({ 
        name, 
        targetAmount: total_amount, 
        minimumPayment: monthly_payment,
        dueDate: next_due_date
      });
      res.json({
        ...debt.toJSON(),
        total_remaining: debt.initialBalance,
      });
    } else {
      res.status(404).send("Debt not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
