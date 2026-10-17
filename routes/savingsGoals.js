const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/savings-goals", async (req, res) => {
  try {
    const goals = await Account.findAll({
      where: { type: "SAVINGS_GOAL" },
      order: [["createdAt", "ASC"]],
    });
    const formatted = goals.map((g) => ({
      ...g.toJSON(),
      current_amount: g.initialBalance,
      goal_amount: g.targetAmount,
      target_date: g.dueDate,
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/savings-goals", async (req, res) => {
  try {
    const startingAmount =
      req.body.current_amount !== undefined && req.body.current_amount !== ""
        ? parseFloat(req.body.current_amount) || 0
        : 0;
    const newGoal = await Account.create({
      name: req.body.name,
      type: "SAVINGS_GOAL",
      targetAmount: req.body.target_amount || req.body.goal_amount,
      dueDate: req.body.target_date || null,
      initialBalance: startingAmount,
    });
    res.status(201).json({
      ...newGoal.toJSON(),
      current_amount: newGoal.initialBalance,
      goal_amount: newGoal.targetAmount,
      target_date: newGoal.dueDate,
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
  const dbTx = await sequelize.transaction();
  try {
    const goal = await Account.findByPk(req.params.id, { transaction: dbTx });
    const [checking] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
      transaction: dbTx,
    });

    if (!goal || !checking) {
      await dbTx.rollback();
      return res.status(404).send("Goal or Primary Checking not found");
    }

    const amount = parseFloat(req.body.amount);
    goal.initialBalance = parseFloat(goal.initialBalance) + amount;
    await goal.save({ transaction: dbTx });

    await Transaction.create(
      {
        title: `Contribution to ${goal.name}`,
        amount,
        date: new Date(),
        type: "TRANSFER",
        category: "Savings Transfer",
        fromAccountId: checking.id,
        toAccountId: goal.id,
        isCleared: true,
      },
      { transaction: dbTx }
    );

    await dbTx.commit();
    res.json({
      ...goal.toJSON(),
      current_amount: goal.initialBalance,
      goal_amount: goal.targetAmount,
      target_date: goal.dueDate,
    });
  } catch (error) {
    await dbTx.rollback();
    res.status(400).json({ error: error.message });
  }
});

router.put("/savings-goals/:id", async (req, res) => {
  try {
    const goal = await Account.findByPk(req.params.id);
    if (goal) {
      const updates = {
        name: req.body.name ?? goal.name,
        targetAmount:
          req.body.target_amount || req.body.goal_amount || goal.targetAmount,
      };
      if (req.body.target_date !== undefined) {
        updates.dueDate = req.body.target_date || null;
      }
      if (
        req.body.current_amount !== undefined &&
        req.body.current_amount !== ""
      ) {
        updates.initialBalance = parseFloat(req.body.current_amount);
      }
      await goal.update(updates);
      res.json({
        ...goal.toJSON(),
        current_amount: goal.initialBalance,
        goal_amount: goal.targetAmount,
        target_date: goal.dueDate,
      });
    } else {
      res.status(404).send("Savings Goal not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
