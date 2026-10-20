const express = require("express");
const crypto = require("crypto");
const { sequelize, Transaction, Account } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { createRecurringExpenses } = require("./recurring");
const router = express.Router();

router.use(authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

// Helper to format YYYY-MM-DD month boundaries cleanly
const getMonthDateRange = (year, month) => {
  const y = parseInt(year);
  const m = parseInt(month);
  const startDate = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { startDate, endDate };
};

// Apply or reverse balance effect of a cleared transaction on linked non-checking accounts
const adjustAccountForTransaction = async (
  trx,
  direction = 1,
  dbTx = null,
  forceApply = false
) => {
  const amount = parseFloat(trx.amount) || 0;
  if (amount === 0) return;

  const todayStr = getTodayString();
  const isPastDated = trx.date < todayStr;

  let toAcc = null;
  if (trx.toAccountId) {
    toAcc = await Account.findByPk(trx.toAccountId, { transaction: dbTx });
  }
  const isSavingsGoal = Boolean(toAcc && toAcc.type === "SAVINGS_GOAL");

  if (direction === 1) {
    // Already applied? Skip to prevent double counting
    if (trx.balanceApplied) return;

    // Unpaid/pending expenses have not affected account balances yet
    if (trx.type === "EXPENSE" && !trx.isCleared) return;

    // Historical past-dated transactions (created with a past date) on cards/debts were already in opening balance.
    // Savings goals are exempt: every contribution towards a savings goal adds to the goal regardless of date.
    // If forceApply is true (e.g. editing an already-applied transaction or overdue bill paid), re-apply regardless of date.
    if (isPastDated && !trx.balanceApplied && !forceApply && !isSavingsGoal) {
      trx.balanceApplied = false;
      await trx.save({ fields: ["balanceApplied"], transaction: dbTx });
      return;
    }

    let applied = false;
    // 1. Cleared expense charged FROM a Credit Card
    if (trx.type === "EXPENSE" && trx.fromAccountId && !trx.toAccountId) {
      const fromAcc = await Account.findByPk(trx.fromAccountId, { transaction: dbTx });
      if (fromAcc && fromAcc.type === "CREDIT_CARD") {
        await Account.increment("initialBalance", {
          by: amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
        applied = true;
      }
    }

    // 2. Cleared EXPENSE or TRANSFER directed TO a Debt, Credit Card, or Savings Goal
    if ((trx.type === "EXPENSE" || trx.type === "TRANSFER") && trx.toAccountId) {
      if (toAcc) {
        if (toAcc.type === "CREDIT_CARD" || toAcc.type === "DEBT") {
          await Account.increment("initialBalance", {
            by: -amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
          applied = true;
        } else if (toAcc.type === "SAVINGS_GOAL") {
          await Account.increment("initialBalance", {
            by: amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
          applied = true;
        }
      }
    }

    if (applied) {
      trx.balanceApplied = true;
      await trx.save({ fields: ["balanceApplied"], transaction: dbTx });
    }
  } else if (direction === -1) {
    // Only reverse if balance was actually applied!
    if (!trx.balanceApplied) return;

    // 1. Reverse expense charged FROM a Credit Card
    if (trx.type === "EXPENSE" && trx.fromAccountId && !trx.toAccountId) {
      const fromAcc = await Account.findByPk(trx.fromAccountId, { transaction: dbTx });
      if (fromAcc && fromAcc.type === "CREDIT_CARD") {
        await Account.increment("initialBalance", {
          by: -amount,
          where: { id: trx.fromAccountId },
          transaction: dbTx,
        });
      }
    }

    // 2. Reverse EXPENSE or TRANSFER directed TO a Debt, Credit Card, or Savings Goal
    if ((trx.type === "EXPENSE" || trx.type === "TRANSFER") && trx.toAccountId) {
      if (toAcc) {
        if (toAcc.type === "CREDIT_CARD" || toAcc.type === "DEBT") {
          await Account.increment("initialBalance", {
            by: amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
        } else if (toAcc.type === "SAVINGS_GOAL") {
          await Account.increment("initialBalance", {
            by: -amount,
            where: { id: trx.toAccountId },
            transaction: dbTx,
          });
        }
      }
    }

    trx.balanceApplied = false;
    await trx.save({ fields: ["balanceApplied"], transaction: dbTx });
  }
};

// Resolve target Debt or Credit Card account when a transaction is categorized as Debt
const resolvePaydownTargetId = async (
  explicitTargetId,
  category,
  title,
  dbTx = null
) => {
  if (explicitTargetId) {
    const acc = await Account.findByPk(explicitTargetId, {
      transaction: dbTx,
    });
    if (acc) return acc.id;
  }

  if (category === "Debt" && title) {
    const candidates = await Account.findAll({
      where: {
        type: { [Op.in]: ["DEBT", "CREDIT_CARD"] },
        isActive: { [Op.ne]: false },
      },
      transaction: dbTx,
    });
    const normalizedTitle = title.toLowerCase().trim();
    const matched = candidates.find((acc) => {
      const accName = (acc.name || "").toLowerCase().trim();
      return (
        accName &&
        (normalizedTitle === accName ||
          normalizedTitle.includes(accName) ||
          accName.includes(normalizedTitle))
      );
    });
    if (matched) return matched.id;
  }

  return null;
};

// Map old "monthly expenses" API shape
router.get(
  "/expenses/monthly",
  asyncHandler(async (req, res) => {
    const { year, month, sortBy = "date", sortOrder = "ASC" } = req.query;
    const { startDate, endDate } = getMonthDateRange(year, month);

    const allowedSortBy = ["date", "title", "amount"];
    const sortField =
      sortBy === "due_date" || sortBy === "payment_date"
        ? "date"
        : sortBy === "name"
        ? "title"
        : sortBy;

    if (!allowedSortBy.includes(sortField)) {
      return res.status(400).json({ error: "Invalid sort parameter." });
    }

    const expenses = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        date: { [Op.between]: [startDate, endDate] },
      },
      order: [[sortField, sortOrder.toUpperCase() === "DESC" ? "DESC" : "ASC"]],
    });

    const formatted = expenses.map((e) => ({
      ...e.toJSON(),
      due_date: e.date,
      name: e.title,
      is_paid: e.isCleared,
      targetAccountId: e.toAccountId || null,
    }));
    res.json(formatted);
  })
);

// Category drill-down endpoint for ReportsPage pie chart
router.get(
  "/expenses/category",
  asyncHandler(async (req, res) => {
    const { year, month, category } = req.query;
    if (!year || !month || !category) {
      return res
        .status(400)
        .json({ error: "year, month, and category are required." });
    }

    const { startDate, endDate } = getMonthDateRange(year, month);

    const transactions = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        category,
        date: { [Op.between]: [startDate, endDate] },
      },
      order: [["date", "DESC"]],
      include: [
        { model: Account, as: "fromAccount" },
        { model: Account, as: "toAccount" },
      ],
    });

    const formatted = transactions.map((t) => ({
      id: t.id,
      name: t.title,
      amount: parseFloat(t.amount),
      date: t.date,
      category: t.category,
      is_paid: t.isCleared,
      fromAccount: t.fromAccount ? t.fromAccount.name : null,
      toAccount: t.toAccount ? t.toAccount.name : null,
    }));

    res.json(formatted);
  })
);

// Full ledger: Transactions of ALL types combined natively
router.get(
  "/expenses/all",
  asyncHandler(async (req, res) => {
    const all = await Transaction.findAll({
      order: [
        ["date", "DESC"],
        ["createdAt", "DESC"],
      ],
      include: [
        { model: Account, as: "fromAccount" },
        { model: Account, as: "toAccount" },
      ],
    });

    const rows = all.map((t) => ({
      id: t.id,
      type: t.type.toLowerCase(),
      name: t.title,
      amount: parseFloat(t.amount),
      date: t.date,
      due_date: t.date,
      payment_date: t.type === "INCOME" ? t.date : undefined,
      category: t.category,
      is_paid: t.isCleared,
      balanceApplied: Boolean(t.balanceApplied),
      recurrence: t.recurrence || "none",
      creditCardId:
        t.fromAccount && t.fromAccount.type === "CREDIT_CARD"
          ? t.fromAccount.id
          : null,
      targetAccountId: t.toAccountId || null,
      fromAccount: t.fromAccount ? t.fromAccount.name : null,
      toAccount: t.toAccount ? t.toAccount.name : null,
    }));

    res.json(rows);
  })
);

router.post(
  "/expenses",
  validateBody(schemas.createExpense),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const {
        name,
        amount,
        due_date,
        category,
        is_paid,
        creditCardId,
        targetAccountId,
        toAccountId,
        recurrence,
      } = req.body;

      const todayStr = getTodayString();
      const expenseDate = due_date || todayStr;
      const finalCategory = category || "Other";

      let [fromAccount] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });

      // Resolve whether this expense pays down a specific Debt or Credit Card
      const resolvedToAccountId = await resolvePaydownTargetId(
        targetAccountId || toAccountId,
        finalCategory,
        name,
        dbTx
      );

      let targetAccount = null;
      if (resolvedToAccountId) {
        targetAccount = await Account.findByPk(resolvedToAccountId, {
          transaction: dbTx,
        });
      }

      if (creditCardId && !resolvedToAccountId) {
        const cardAccount = await Account.findByPk(creditCardId, {
          transaction: dbTx,
        });
        if (cardAccount) fromAccount = cardAccount;
      }

      // Default to cleared (paid) if expense date is today or in the past, unless explicitly specified
      const isCleared =
        is_paid !== undefined ? Boolean(is_paid) : expenseDate <= todayStr;

      const rawAmount = parseFloat(amount);
      const taxRateNum =
        req.body.taxRate !== undefined && req.body.taxRate !== null
          ? parseFloat(req.body.taxRate)
          : null;
      const isTaxExclusive = Boolean(
        req.body.isTaxExclusive && taxRateNum && taxRateNum > 0
      );

      let effectiveAmount = rawAmount;
      let taxApplied = false;

      // If marked paid/cleared immediately and isTaxExclusive is true, apply tax immediately
      if (isCleared && isTaxExclusive) {
        effectiveAmount =
          Math.round(rawAmount * (1 + taxRateNum / 100) * 100) / 100;
        taxApplied = true;
      }

      // If paying toward a credit card, treat as a TRANSFER so card purchases are not double-counted
      const isCreditCardPayment =
        targetAccount && targetAccount.type === "CREDIT_CARD";
      const trxType = isCreditCardPayment ? "TRANSFER" : "EXPENSE";
      const trxCategory =
        isCreditCardPayment && finalCategory === "Debt"
          ? "Credit Card Payment"
          : finalCategory;

      const isRecurring = recurrence && recurrence !== "none";
      const finalRecurringGroupId =
        req.body.recurringGroupId || (isRecurring ? crypto.randomUUID() : null);

      const newExp = await Transaction.create(
        {
          title: name,
          amount: effectiveAmount,
          baseAmount: rawAmount,
          isTaxExclusive,
          taxRate: taxRateNum,
          taxApplied,
          date: expenseDate,
          type: trxType,
          category: trxCategory,
          isCleared,
          recurrence: recurrence || "none",
          recurringGroupId: finalRecurringGroupId,
          fromAccountId: fromAccount.id,
          toAccountId: resolvedToAccountId,
        },
        { transaction: dbTx }
      );

      // Apply balance change on Credit Card (charge) or Debt/Credit Card (paydown) if cleared
      await adjustAccountForTransaction(newExp, 1, dbTx);

      await dbTx.commit();
      res.status(201).json(newExp);

      if (recurrence && recurrence !== "none") {
        createRecurringExpenses().catch((err) =>
          console.error("Background recurring generation error:", err)
        );
      }
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.put(
  "/expenses/:id",
  validateBody(schemas.updateExpense),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const trx = await Transaction.findByPk(req.params.id, {
        transaction: dbTx,
      });
      if (!trx) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Transaction not found" });
      }

      const wasCleared = Boolean(trx.isCleared);
      const wasBalanceApplied = Boolean(trx.balanceApplied);
      // Reverse old transaction's effect on any linked credit card / debt / savings account
      await adjustAccountForTransaction(trx, -1, dbTx);

      let fromAccountId = trx.fromAccountId;
      if (req.body.creditCardId !== undefined) {
        if (req.body.creditCardId) {
          fromAccountId = req.body.creditCardId;
        } else {
          const [checking] = await Account.findOrCreate({
            where: { name: "Primary Checking" },
            defaults: { type: "CHECKING", initialBalance: 0.0 },
            transaction: dbTx,
          });
          fromAccountId = checking.id;
        }
      }

      const nextTitle = req.body.name || trx.title;
      const nextCategory = req.body.category || trx.category;

      let nextToAccountId = trx.toAccountId;
      if (
        req.body.targetAccountId !== undefined ||
        req.body.toAccountId !== undefined
      ) {
        const explicitTarget =
          req.body.targetAccountId !== undefined
            ? req.body.targetAccountId
            : req.body.toAccountId;
        nextToAccountId = await resolvePaydownTargetId(
          explicitTarget,
          nextCategory,
          nextTitle,
          dbTx
        );
      } else if (nextCategory === "Debt" && !nextToAccountId) {
        nextToAccountId = await resolvePaydownTargetId(
          null,
          nextCategory,
          nextTitle,
          dbTx
        );
      }

      let targetAccount = null;
      if (nextToAccountId) {
        targetAccount = await Account.findByPk(nextToAccountId, {
          transaction: dbTx,
        });
      }

      const isCreditCardPayment =
        targetAccount && targetAccount.type === "CREDIT_CARD";
      const nextType = isCreditCardPayment
        ? "TRANSFER"
        : req.body.type
        ? String(req.body.type).toUpperCase()
        : trx.type;

      const nextIsCleared =
        req.body.is_paid !== undefined
          ? Boolean(req.body.is_paid)
          : trx.isCleared;

      const nextIsTaxExclusive =
        req.body.isTaxExclusive !== undefined
          ? Boolean(req.body.isTaxExclusive)
          : Boolean(trx.isTaxExclusive);

      const nextTaxRate =
        req.body.taxRate !== undefined
          ? req.body.taxRate !== null
            ? parseFloat(req.body.taxRate)
            : null
          : trx.taxRate !== null && trx.taxRate !== undefined
          ? parseFloat(trx.taxRate)
          : null;

      let nextBaseAmount;
      if (req.body.baseAmount !== undefined && req.body.baseAmount !== null) {
        nextBaseAmount = parseFloat(req.body.baseAmount);
      } else if (req.body.amount !== undefined && req.body.amount !== null) {
        if (
          trx.isTaxExclusive &&
          trx.taxApplied &&
          parseFloat(req.body.amount) === parseFloat(trx.amount) &&
          trx.baseAmount !== null &&
          trx.baseAmount !== undefined
        ) {
          // Caller passed the existing tax-inclusive total amount without intending to compound tax
          nextBaseAmount = parseFloat(trx.baseAmount);
        } else {
          // Caller explicitly supplied a new amount for this tax-exclusive expense; treat it as the new pre-tax baseAmount
          nextBaseAmount = parseFloat(req.body.amount);
        }
      } else if (trx.baseAmount !== null && trx.baseAmount !== undefined) {
        nextBaseAmount = parseFloat(trx.baseAmount);
      } else {
        nextBaseAmount = parseFloat(trx.amount);
      }

      let nextTaxApplied = false;
      let nextAmount = nextBaseAmount;

      if (nextIsTaxExclusive && nextTaxRate && nextTaxRate > 0) {
        if (nextIsCleared) {
          nextAmount =
            Math.round(nextBaseAmount * (1 + nextTaxRate / 100) * 100) / 100;
          nextTaxApplied = true;
        } else {
          nextAmount = nextBaseAmount;
          nextTaxApplied = false;
        }
      } else {
        nextAmount =
          req.body.amount !== undefined && req.body.amount !== null
            ? parseFloat(req.body.amount)
            : parseFloat(trx.amount);
        nextBaseAmount = null;
        nextTaxApplied = false;
      }

      const nextRecurrence =
        req.body.recurrence !== undefined ? req.body.recurrence : trx.recurrence;
      let nextRecurringGroupId = trx.recurringGroupId;
      if (req.body.recurringGroupId !== undefined) {
        nextRecurringGroupId = req.body.recurringGroupId;
      } else if (nextRecurrence && nextRecurrence !== "none") {
        if (!nextRecurringGroupId) {
          nextRecurringGroupId = crypto.randomUUID();
        }
      } else {
        nextRecurringGroupId = null;
      }

      await trx.update(
        {
          title: nextTitle,
          amount: nextAmount,
          baseAmount: nextBaseAmount,
          isTaxExclusive: nextIsTaxExclusive,
          taxRate: nextTaxRate,
          taxApplied: nextTaxApplied,
          date: req.body.due_date || req.body.payment_date || trx.date,
          type: nextType,
          category:
            isCreditCardPayment && nextCategory === "Debt"
              ? "Credit Card Payment"
              : nextCategory,
          isCleared: nextIsCleared,
          recurrence: nextRecurrence,
          recurringGroupId: nextRecurringGroupId,
          fromAccountId,
          toAccountId: nextToAccountId,
        },
        { transaction: dbTx }
      );

      // Apply updated transaction's effect on linked account, preserving applied status if it had already been applied
      // or if transitioning from unpaid to paid (e.g. overdue bill paid manually)
      await adjustAccountForTransaction(
        trx,
        1,
        dbTx,
        wasBalanceApplied || (!wasCleared && nextIsCleared)
      );

      await dbTx.commit();
      res.json(trx);

      if (req.body.recurrence && req.body.recurrence !== "none") {
        createRecurringExpenses().catch((err) =>
          console.error("Background recurring generation error:", err)
        );
      }
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.post(
  "/expenses/bulk-delete",
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        await dbTx.rollback();
        return res.status(400).json({ error: "No transaction IDs provided." });
      }

      const toDelete = await Transaction.findAll({
        where: { id: { [Op.in]: ids } },
        transaction: dbTx,
      });

      for (const trx of toDelete) {
        await adjustAccountForTransaction(trx, -1, dbTx);
      }

      const deletedCount = await Transaction.destroy({
        where: { id: { [Op.in]: ids } },
        transaction: dbTx,
      });

      await dbTx.commit();
      res.json({ deletedCount });
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.delete(
  "/expenses/:id",
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const trx = await Transaction.findByPk(req.params.id, {
        transaction: dbTx,
      });
      if (!trx) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Transaction not found" });
      }

      await adjustAccountForTransaction(trx, -1, dbTx);
      await trx.destroy({ transaction: dbTx });

      await dbTx.commit();
      res.status(204).send();
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

module.exports = router;
