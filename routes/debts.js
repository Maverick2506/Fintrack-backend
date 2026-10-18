const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
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

const formatDebtResponse = (d) => {
  const json = d.toJSON ? d.toJSON() : d;
  return {
    ...json,
    total_amount: json.targetAmount ?? json.initialBalance,
    total_remaining: json.initialBalance,
    monthly_payment: json.minimumPayment,
    next_due_date: json.dueDate,
    auto_pay: Boolean(json.autoPay),
    payment_frequency: json.paymentFrequency || "monthly",
    interest_rate: json.interestRate,
  };
};

router.get(
  "/debts",
  asyncHandler(async (req, res) => {
    const debts = await Account.findAll({
      where: { type: "DEBT", isActive: { [Op.ne]: false } },
      order: [["createdAt", "ASC"]],
    });
    res.json(debts.map(formatDebtResponse));
  })
);

router.post(
  "/debts",
  validateBody(schemas.createDebt),
  asyncHandler(async (req, res) => {
    const {
      name,
      total_amount,
      monthly_payment,
      auto_pay,
      next_due_date,
      payment_frequency,
      interest_rate,
      interestRate,
    } = req.body;

    const parsedRate =
      interest_rate !== undefined && interest_rate !== null
        ? parseFloat(interest_rate)
        : interestRate !== undefined && interestRate !== null
        ? parseFloat(interestRate)
        : null;

    const newDebt = await Account.create({
      name,
      type: "DEBT",
      initialBalance: total_amount,
      targetAmount: total_amount,
      minimumPayment: monthly_payment || null,
      dueDate: next_due_date || null,
      autoPay: Boolean(auto_pay),
      paymentFrequency: payment_frequency || "monthly",
      interestRate: parsedRate !== null && !isNaN(parsedRate) ? parsedRate : null,
      isActive: true,
    });

    res.status(201).json(formatDebtResponse(newDebt));
  })
);

router.post(
  "/debts/:id/pay",
  validateBody(schemas.paymentAmount),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const debt = await Account.findByPk(req.params.id, { transaction: dbTx });
      const [checking] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });

      if (!debt || debt.type !== "DEBT") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Debt not found" });
      }

      const paymentAmount = parseFloat(req.body.amount);
      const remainingDebt = parseFloat(debt.initialBalance || 0);

      if (paymentAmount > remainingDebt) {
        await dbTx.rollback();
        return res.status(400).json({
          error: `Payment amount ($${paymentAmount.toFixed(
            2
          )}) cannot exceed remaining debt balance ($${remainingDebt.toFixed(2)}).`,
        });
      }

      debt.initialBalance = remainingDebt - paymentAmount;
      await debt.save({ transaction: dbTx });

      // Record as EXPENSE under "Debt" category so it registers in both Monthly Expenses/Analytics AND Debt paydown
      await Transaction.create(
        {
          title: `Payment for ${debt.name}`,
          amount: paymentAmount,
          date: getTodayString(),
          type: "EXPENSE",
          category: "Debt",
          isCleared: true,
          fromAccountId: checking.id,
          toAccountId: debt.id,
        },
        { transaction: dbTx }
      );

      await dbTx.commit();
      res.json(formatDebtResponse(debt));
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.delete(
  "/debts/:id",
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const debt = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!debt || debt.type !== "DEBT") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Debt not found" });
      }

      // Unlink any transactions referencing this debt so transaction history is preserved
      await Transaction.update(
        { fromAccountId: null },
        { where: { fromAccountId: debt.id }, transaction: dbTx }
      );
      await Transaction.update(
        { toAccountId: null },
        { where: { toAccountId: debt.id }, transaction: dbTx }
      );

      // Truly delete the debt record from the database
      await debt.destroy({ transaction: dbTx });

      await dbTx.commit();
      res.status(204).send();
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.put(
  "/debts/:id",
  asyncHandler(async (req, res) => {
    const debt = await Account.findByPk(req.params.id);
    if (!debt || debt.type !== "DEBT") {
      return res.status(404).json({ error: "Debt not found" });
    }

    const {
      name,
      total_amount,
      total_remaining,
      monthly_payment,
      auto_pay,
      next_due_date,
      payment_frequency,
      interest_rate,
      interestRate,
    } = req.body;

    const updates = {
      name: name ?? debt.name,
      targetAmount:
        total_amount !== undefined ? parseFloat(total_amount) : debt.targetAmount,
      minimumPayment:
        monthly_payment !== undefined
          ? parseFloat(monthly_payment)
          : debt.minimumPayment,
      dueDate:
        next_due_date !== undefined ? next_due_date || null : debt.dueDate,
    };

    if (total_remaining !== undefined && total_remaining !== "") {
      updates.initialBalance = parseFloat(total_remaining);
    }
    if (auto_pay !== undefined) {
      updates.autoPay = Boolean(auto_pay);
    }
    if (payment_frequency !== undefined) {
      updates.paymentFrequency = payment_frequency || "monthly";
    }
    if (interest_rate !== undefined || interestRate !== undefined) {
      const rawRate =
        interest_rate !== undefined ? interest_rate : interestRate;
      updates.interestRate =
        rawRate === "" || rawRate === null ? null : parseFloat(rawRate);
    }

    await debt.update(updates);
    res.json(formatDebtResponse(debt));
  })
);

module.exports = router;
