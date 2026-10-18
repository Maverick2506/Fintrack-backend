const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const router = express.Router();

router.use(authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

router.get(
  "/savings-goals",
  asyncHandler(async (req, res) => {
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
  })
);

router.post(
  "/savings-goals",
  validateBody(schemas.createSavingsGoal),
  asyncHandler(async (req, res) => {
    const startingAmount =
      req.body.current_amount !== undefined
        ? parseFloat(req.body.current_amount) || 0
        : req.body.initialBalance !== undefined
        ? parseFloat(req.body.initialBalance) || 0
        : 0;

    const targetAmount = req.body.target_amount ?? req.body.goal_amount ?? 0;

    const newGoal = await Account.create({
      name: req.body.name,
      type: "SAVINGS_GOAL",
      targetAmount: parseFloat(targetAmount),
      dueDate: req.body.target_date || req.body.dueDate || null,
      initialBalance: startingAmount,
    });

    res.status(201).json({
      ...newGoal.toJSON(),
      current_amount: newGoal.initialBalance,
      goal_amount: newGoal.targetAmount,
      target_date: newGoal.dueDate,
    });
  })
);

router.delete(
  "/savings-goals/:id",
  asyncHandler(async (req, res) => {
    const goal = await Account.findByPk(req.params.id);
    if (goal && goal.type === "SAVINGS_GOAL") {
      await goal.destroy();
      res.status(204).send();
    } else {
      res.status(404).json({ error: "Savings Goal not found" });
    }
  })
);

router.post(
  "/savings-goals/:id/contribute",
  validateBody(schemas.paymentAmount),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const goal = await Account.findByPk(req.params.id, { transaction: dbTx });
      const [checking] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });

      if (!goal || goal.type !== "SAVINGS_GOAL") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Goal not found" });
      }

      const amount = parseFloat(req.body.amount);
      goal.initialBalance = parseFloat(goal.initialBalance || 0) + amount;
      await goal.save({ transaction: dbTx });

      await Transaction.create(
        {
          title: `Contribution to ${goal.name}`,
          amount,
          date: getTodayString(),
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
      throw error;
    }
  })
);

router.put(
  "/savings-goals/:id",
  asyncHandler(async (req, res) => {
    const goal = await Account.findByPk(req.params.id);
    if (goal && goal.type === "SAVINGS_GOAL") {
      const updates = {
        name: req.body.name ?? goal.name,
      };
      if (
        req.body.target_amount !== undefined ||
        req.body.goal_amount !== undefined
      ) {
        updates.targetAmount = parseFloat(
          req.body.target_amount ?? req.body.goal_amount
        );
      }
      if (
        req.body.target_date !== undefined ||
        req.body.dueDate !== undefined
      ) {
        updates.dueDate = req.body.target_date || req.body.dueDate || null;
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
      res.status(404).json({ error: "Savings Goal not found" });
    }
  })
);

module.exports = router;
