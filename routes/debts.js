const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { retireAccount } = require("../services/accountArchiveService");
const router = express.Router();

// Day of month from a YYYY-MM-DD due date (R3)
const dueDayOf = (dateStr) => (dateStr ? parseInt(String(dateStr).split("-")[2], 10) || null : null);
router.param("id", validateIdParam);

router.use("/debts", authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

const formatDebtResponse = (d) => {
  const json = d.toJSON ? d.toJSON() : d;
  const isPaidDown = parseFloat(json.initialBalance || 0) <= 0;
  return {
    ...json,
    total_amount: json.targetAmount ?? json.initialBalance,
    total_remaining: json.initialBalance,
    monthly_payment: json.minimumPayment,
    next_due_date: json.dueDate,
    auto_pay: Boolean(json.autoPay),
    payment_frequency: json.paymentFrequency || "monthly",
    interest_rate: json.interestRate,
    is_paid_down: isPaidDown,
    is_archived: isPaidDown || json.isActive === false,
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
      dueDay: dueDayOf(next_due_date),
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

      await Account.increment("initialBalance", {
        by: -paymentAmount,
        where: { id: debt.id },
        transaction: dbTx,
      });
      await debt.reload({ transaction: dbTx });

      // Record as a TRANSFER to the debt (like card payments): it lowers checking and the debt, not spending (C5)
      await Transaction.create(
        {
          title: `Payment for ${debt.name}`,
          amount: paymentAmount,
          date: getTodayString(),
          type: "TRANSFER",
          category: "Debt",
          isCleared: true,
          balanceApplied: true,
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

// Archives by default. Unpaid rows and recurring series using it are ended or moved to Checking.
router.delete(
  "/debts/:id",
  validateBody(schemas.retireAccount),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const debt = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!debt || debt.type !== "DEBT") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Debt not found" });
      }

      await retireAccount(debt, req.body, dbTx);

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
  validateBody(schemas.updateDebt),
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
        total_amount !== undefined
          ? total_amount !== null
            ? parseFloat(total_amount)
            : debt.targetAmount
          : debt.targetAmount,
      minimumPayment:
        monthly_payment !== undefined
          ? monthly_payment !== null
            ? parseFloat(monthly_payment)
            : null
          : debt.minimumPayment,
      dueDate:
        next_due_date !== undefined ? next_due_date || null : debt.dueDate,
    };

    // A due date the user sets is the new anchor day
    if (next_due_date !== undefined && (next_due_date || null) !== debt.dueDate) {
      updates.dueDay = dueDayOf(next_due_date);
    }

    if (
      total_remaining !== undefined &&
      total_remaining !== "" &&
      total_remaining !== null
    ) {
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
