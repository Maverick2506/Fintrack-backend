const express = require("express");
const { Account, Transaction } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/savings-goals", async (req, res) => {
  try {
    const goals = await Account.findAll({ where: { type: "SAVINGS_GOAL" } });
    const formatted = goals.map(g => ({
      ...g.toJSON(),
      current_amount: g.initialBalance,
      goal_amount: g.targetAmount,
      target_date: g.dueDate
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/savings-goals", async (req, res) => {
  try {
    const newGoal = await Account.create({
      name: req.body.name,
      type: "SAVINGS_GOAL",
      targetAmount: req.body.target_amount || req.body.goal_amount,
      dueDate: req.body.target_date,
      initialBalance: 0,
    });
    res.status(201).json({
      ...newGoal.toJSON(),
      current_amount: newGoal.initialBalance,
      goal_amount: newGoal.targetAmount,
      target_date: newGoal.dueDate
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/savings-goals/:id", async (req, res) => {
  try {
    const goal = await Account.findByPk(req.params.id);
    if (goal) {
      await goal.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Savings Goal not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/savings-goals/:id/contribute", async (req, res) => {
  try {
    const goal = await Account.findByPk(req.params.id);
    let checking = await Account.findOne({ where: { name: "Primary Checking" } });

    if (goal && checking) {
      goal.initialBalance = parseFloat(goal.initialBalance) + parseFloat(req.body.amount);
      await goal.save();

      // **CREATE THE TRANSFER TRANSACTION!** (Fulfills the user's specific request)
      await Transaction.create({
        title: `Contribution to ${goal.name}`,
        amount: req.body.amount,
        date: new Date(),
        type: "TRANSFER",
        category: "Savings Transfer",
        fromAccountId: checking.id,
        toAccountId: goal.id,
        isCleared: true,
      });

      res.json({
        ...goal.toJSON(),
        current_amount: goal.initialBalance,
        goal_amount: goal.targetAmount,
        target_date: goal.dueDate
      });
    } else {
      res.status(404).send("Goal or Primary Checking not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put("/savings-goals/:id", async (req, res) => {
  try {
    const goal = await Account.findByPk(req.params.id);
    if (goal) {
      await goal.update({
        name: req.body.name,
        targetAmount: req.body.target_amount || req.body.goal_amount,
        dueDate: req.body.target_date
      });
      res.json({
        ...goal.toJSON(),
        current_amount: goal.initialBalance,
        goal_amount: goal.targetAmount,
        target_date: goal.dueDate
      });
    } else {
      res.status(404).send("Savings Goal not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
