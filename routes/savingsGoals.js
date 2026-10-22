const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const { subDays } = require("date-fns");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const router = express.Router();
router.param("id", validateIdParam);

router.use("/savings-goals", authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

router.get(
  "/savings-goals",
  asyncHandler(async (req, res) => {
    const goals = await Account.findAll({
      where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false } },
      order: [["createdAt", "ASC"]],
    });

    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const cutoff90Days = format(subDays(nowZoned, 90), "yyyy-MM-dd", {
      timeZone: TIMEZONE,
    });
    const goalIds = goals.map((g) => g.id);

    const contributionMap = {};
    if (goalIds.length > 0) {
      const contributions = await Transaction.findAll({
        attributes: ["toAccountId", "amount"],
        where: {
          toAccountId: { [Op.in]: goalIds },
          isCleared: true,
          date: { [Op.gte]: cutoff90Days },
        },
        raw: true,
      });

      for (const c of contributions) {
        contributionMap[c.toAccountId] =
          (contributionMap[c.toAccountId] || 0) + (parseFloat(c.amount) || 0);
      }
    }

    // Phase J: Registered Account Calculations (TFSA, RRSP, FHSA)
    const registeredGoals = goals.filter((g) => g.registeredType);
    const regContributionsMap = {};
    const regWithdrawalsMap = {};

    if (registeredGoals.length > 0) {
      const currentYear = nowZoned.getFullYear();
      for (const rg of registeredGoals) {
        const year = rg.roomYear || currentYear;
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;

        const [inflow, outflow] = await Promise.all([
          Transaction.sum("amount", {
            where: {
              toAccountId: rg.id,
              isCleared: true,
              date: { [Op.between]: [yearStart, yearEnd] },
            },
          }),
          Transaction.sum("amount", {
            where: {
              fromAccountId: rg.id,
              isCleared: true,
              date: { [Op.between]: [yearStart, yearEnd] },
            },
          }),
        ]);

        regContributionsMap[rg.id] = parseFloat(inflow) || 0;
        regWithdrawalsMap[rg.id] = parseFloat(outflow) || 0;
      }
    }

    const formatted = goals.map((g) => {
      const isRegistered = Boolean(g.registeredType);
      const contRoom =
        g.contributionRoom !== null && g.contributionRoom !== undefined
          ? parseFloat(g.contributionRoom)
          : null;
      const contributedThisYear = isRegistered
        ? Math.round((regContributionsMap[g.id] || 0) * 100) / 100
        : null;
      const withdrawnThisYear = isRegistered
        ? Math.round((regWithdrawalsMap[g.id] || 0) * 100) / 100
        : null;
      const roomLeft =
        isRegistered && contRoom !== null
          ? Math.round((contRoom - contributedThisYear) * 100) / 100
          : null;
      const isOverContributed = roomLeft !== null && roomLeft < 0;
      const roomReturnsNextYear =
        isRegistered && g.registeredType === "TFSA" ? withdrawnThisYear : null;

      return {
        ...g.toJSON(),
        current_amount: g.initialBalance,
        goal_amount: g.targetAmount,
        target_date: g.dueDate,
        contributedLast90Days:
          Math.round((contributionMap[g.id] || 0) * 100) / 100,
        registeredType: g.registeredType || null,
        contributionRoom: contRoom,
        roomYear: g.roomYear || null,
        contributedThisYear,
        withdrawnThisYear,
        roomLeft,
        isOverContributed,
        roomReturnsNextYear,
      };
    });
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

    const regType = req.body.registeredType
      ? String(req.body.registeredType).toUpperCase()
      : null;
    const contRoom =
      req.body.contributionRoom !== undefined &&
      req.body.contributionRoom !== null &&
      req.body.contributionRoom !== ""
        ? parseFloat(req.body.contributionRoom)
        : null;
    const rYear = req.body.roomYear
      ? parseInt(req.body.roomYear, 10)
      : regType
      ? new Date().getFullYear()
      : null;

    const newGoal = await Account.create({
      name: req.body.name,
      type: "SAVINGS_GOAL",
      targetAmount: parseFloat(targetAmount),
      dueDate: req.body.target_date || req.body.dueDate || null,
      initialBalance: startingAmount,
      isActive: true,
      registeredType: regType,
      contributionRoom: contRoom,
      roomYear: rYear,
    });

    res.status(201).json({
      ...newGoal.toJSON(),
      current_amount: newGoal.initialBalance,
      goal_amount: newGoal.targetAmount,
      target_date: newGoal.dueDate,
      contributedLast90Days: 0,
      registeredType: newGoal.registeredType,
      contributionRoom: newGoal.contributionRoom !== null ? parseFloat(newGoal.contributionRoom) : null,
      roomYear: newGoal.roomYear,
      contributedThisYear: 0,
      withdrawnThisYear: 0,
      roomLeft: newGoal.contributionRoom !== null ? parseFloat(newGoal.contributionRoom) : null,
      isOverContributed: false,
      roomReturnsNextYear: newGoal.registeredType === "TFSA" ? 0 : null,
    });
  })
);

router.delete(
  "/savings-goals/:id",
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const goal = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!goal || goal.type !== "SAVINGS_GOAL") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Savings Goal not found" });
      }

      // Unlink any transactions referencing this savings goal so contribution history is preserved
      await Transaction.update(
        { fromAccountId: null },
        { where: { fromAccountId: goal.id }, transaction: dbTx }
      );
      await Transaction.update(
        { toAccountId: null },
        { where: { toAccountId: goal.id }, transaction: dbTx }
      );

      // Truly delete the savings goal record from the database
      await goal.destroy({ transaction: dbTx });

      await dbTx.commit();
      res.status(204).send();
    } catch (error) {
      await dbTx.rollback();
      throw error;
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
      // Atomic increment avoids lost updates under concurrency
      await Account.increment("initialBalance", {
        by: amount,
        where: { id: goal.id },
        transaction: dbTx,
      });
      await goal.reload({ transaction: dbTx });

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
          balanceApplied: true,
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
  validateBody(schemas.updateSavingsGoal),
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
        const rawTarget = req.body.target_amount ?? req.body.goal_amount;
        if (rawTarget !== null && rawTarget !== undefined) {
          updates.targetAmount = parseFloat(rawTarget);
        }
      }
      if (
        req.body.target_date !== undefined ||
        req.body.dueDate !== undefined
      ) {
        updates.dueDate = req.body.target_date || req.body.dueDate || null;
      }
      if (
        req.body.current_amount !== undefined &&
        req.body.current_amount !== "" &&
        req.body.current_amount !== null
      ) {
        updates.initialBalance = parseFloat(req.body.current_amount);
      }
      if (req.body.registeredType !== undefined) {
        updates.registeredType = req.body.registeredType
          ? String(req.body.registeredType).toUpperCase()
          : null;
      }
      if (req.body.contributionRoom !== undefined) {
        updates.contributionRoom =
          req.body.contributionRoom !== null && req.body.contributionRoom !== ""
            ? parseFloat(req.body.contributionRoom)
            : null;
      }
      if (req.body.roomYear !== undefined) {
        updates.roomYear = req.body.roomYear
          ? parseInt(req.body.roomYear, 10)
          : null;
      }

      await goal.update(updates);
      res.json({
        ...goal.toJSON(),
        current_amount: goal.initialBalance,
        goal_amount: goal.targetAmount,
        target_date: goal.dueDate,
        registeredType: goal.registeredType,
        contributionRoom: goal.contributionRoom !== null ? parseFloat(goal.contributionRoom) : null,
        roomYear: goal.roomYear,
      });
    } else {
      res.status(404).json({ error: "Savings Goal not found" });
    }
  })
);

module.exports = router;
