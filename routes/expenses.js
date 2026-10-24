const express = require("express");
const crypto = require("crypto");
const { sequelize, Transaction, Account } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateQuery, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { createRecurringExpenses } = require("./recurring");
const { isClientRefConflict } = require("../services/clientRefService");
const {
  snapshotArchivedBalances,
  assertArchivedBalancesUnchanged,
} = require("../services/accountArchiveService");
const {
  adjustAccountForTransaction,
  getTodayString,
  TIMEZONE,
} = require("../services/accountBalanceService");
const {
  softDeleteTransactions,
  restoreTransactions,
  listTrash,
} = require("../services/trashService");
const router = express.Router();
router.param("id", validateIdParam);

router.use("/expenses", authMiddleware);

// Response for a create whose clientRef was already saved (an idempotent retry)
const duplicateExpenseResponse = (existing) => ({
  ...existing.toJSON(),
  id: existing.id,
  name: existing.title,
  amount: parseFloat(existing.amount),
  date: existing.date,
  due_date: existing.date,
  category: existing.category,
  is_paid: existing.isCleared,
  isDuplicate: true,
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

// Generates upcoming rows once the save has committed (N5). Running it inside the save's transaction
// meant a failure could abort that transaction on Postgres, and the commit then rolled back silently.
// The row is already saved here, so a failure is logged and the nightly job fills the gap.
const generateAfterSave = async () => {
  try {
    await createRecurringExpenses();
  } catch (err) {
    console.error("Recurring generation after save failed:", err);
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
    // Prefer exact match first
    const exactMatch = candidates.find(
      (acc) => (acc.name || "").toLowerCase().trim() === normalizedTitle
    );
    if (exactMatch) return exactMatch.id;

    // Second: check if title is formatted as "Payment for <AccountName>" or "Auto-Pay for <AccountName>"
    const prefixMatch = candidates.find((acc) => {
      const accName = (acc.name || "").toLowerCase().trim();
      return (
        accName &&
        (normalizedTitle === `payment for ${accName}` ||
          normalizedTitle === `auto-pay for ${accName}`)
      );
    });
    if (prefixMatch) return prefixMatch.id;
  }

  return null;
};

// Map old "monthly expenses" API shape
router.get(
  "/expenses/monthly",
  validateQuery(schemas.monthQuery),
  asyncHandler(async (req, res) => {
    const { year, month, sortBy = "date", sortOrder = "ASC" } = req.validatedQuery;
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
      recurringGroupId: t.recurringGroupId || null,
      // Tax fields so editing from the Ledger keeps the tax setting and pre-tax amount (B2)
      isTaxExclusive: Boolean(t.isTaxExclusive),
      taxRate: t.taxRate !== null && t.taxRate !== undefined ? parseFloat(t.taxRate) : null,
      baseAmount:
        t.baseAmount !== null && t.baseAmount !== undefined ? parseFloat(t.baseAmount) : null,
      taxApplied: Boolean(t.taxApplied),
      creditCardId:
        t.fromAccount && t.fromAccount.type === "CREDIT_CARD"
          ? t.fromAccount.id
          : null,
      targetAccountId: t.toAccountId || null,
      fromAccount: t.fromAccount ? t.fromAccount.name : null,
      toAccount: t.toAccount ? t.toAccount.name : null,
      fromAccountType: t.fromAccount ? t.fromAccount.type : null,
      toAccountType: t.toAccount ? t.toAccount.type : null,
      // Archived accounts keep their name in the history
      fromAccountArchived: t.fromAccount ? t.fromAccount.isActive === false : false,
      toAccountArchived: t.toAccount ? t.toAccount.isActive === false : false,
    }));

    res.json(rows);
  })
);

router.post(
  "/expenses",
  validateBody(schemas.createExpense),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    let newExp;
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

      // Resolve whether this expense pays down a specific Debt or Credit Card.
      // Name matching only runs when the client sent no target field at all (e.g. quick add);
      // an explicit null means the user chose "General Debt Expense" (B6).
      const targetFieldSent =
        targetAccountId !== undefined || toAccountId !== undefined;
      const explicitTargetId = targetAccountId || toAccountId || null;
      const resolvedToAccountId =
        targetFieldSent && !explicitTargetId
          ? null
          : await resolvePaydownTargetId(
              explicitTargetId,
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

      // Payments toward a credit card or debt are TRANSFERs: they move money to an account you owe,
      // so they are not spending (C5). Card purchases are already counted when charged.
      const isCreditCardPayment =
        targetAccount && targetAccount.type === "CREDIT_CARD";
      const isDebtPayment = targetAccount && targetAccount.type === "DEBT";
      const trxType =
        isCreditCardPayment || isDebtPayment ? "TRANSFER" : "EXPENSE";
      const trxCategory =
        isCreditCardPayment && finalCategory === "Debt"
          ? "Credit Card Payment"
          : finalCategory;

      // Phase L: Idempotent clientRef check
      if (req.body.clientRef) {
        // A deleted row still holds its clientRef in the unique index, so look in the Trash too
        const existing = await Transaction.findOne({
          where: { clientRef: req.body.clientRef },
          paranoid: false,
          transaction: dbTx,
        });
        if (existing) {
          await dbTx.rollback();
          return res.status(200).json(duplicateExpenseResponse(existing));
        }
      }

      const isRecurring = recurrence && recurrence !== "none";
      const finalRecurringGroupId =
        req.body.recurringGroupId || (isRecurring ? crypto.randomUUID() : null);

      newExp = await Transaction.create(
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
          clientRef: req.body.clientRef || null,
        },
        { transaction: dbTx }
      );

      // Apply balance change on Credit Card (charge) or Debt/Credit Card (paydown) if cleared
      await adjustAccountForTransaction(newExp, 1, dbTx, req.body.applyToBalance === true);

      await dbTx.commit();
    } catch (error) {
      await dbTx.rollback();
      // Two requests with the same clientRef raced past the check above and this one
      // lost on the unique index: the other request saved it, so return that row.
      if (req.body.clientRef && isClientRefConflict(error)) {
        const existing = await Transaction.findOne({
          where: { clientRef: req.body.clientRef },
          paranoid: false,
        });
        if (existing) {
          return res.status(200).json(duplicateExpenseResponse(existing));
        }
      }
      throw error;
    }

    if (newExp.recurrence && newExp.recurrence !== "none") {
      await generateAfterSave();
    }
    res.status(201).json(newExp);
  })
);

router.put(
  "/expenses/:id",
  validateQuery(schemas.dryRunQuery),
  validateBody(schemas.updateExpense),
  asyncHandler(async (req, res) => {
    // dryRun runs the whole update, reports what it would do (seriesEnded, removedUpcomingCount,
    // removedUpcomingTotal) and rolls back, so the client can confirm with exact numbers (R4)
    const dryRun = ["1", "true"].includes(req.validatedQuery.dryRun);
    const dbTx = await sequelize.transaction();
    let updated;
    try {
      const trx = await Transaction.findByPk(req.params.id, {
        transaction: dbTx,
      });
      if (!trx) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Transaction not found" });
      }

      const archivedBefore = await snapshotArchivedBalances(dbTx);
      const wasCleared = Boolean(trx.isCleared);
      const wasBalanceApplied = Boolean(trx.balanceApplied);
      // Reverse old transaction's effect on any linked credit card / debt / savings account
      await adjustAccountForTransaction(trx, -1, dbTx);

      let fromAccountId = trx.fromAccountId;
      // Interest and statement-sync rows are charged to a debt. The edit form only knows cards, so an
      // empty card keeps the debt instead of moving the charge to Checking.
      const fromDebt =
        trx.fromAccountId &&
        (await Account.findByPk(trx.fromAccountId, { transaction: dbTx }))?.type === "DEBT";
      if (req.body.creditCardId !== undefined && !(fromDebt && !req.body.creditCardId)) {
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
      const hasExplicitTarget =
        req.body.targetAccountId !== undefined ||
        req.body.toAccountId !== undefined;
      const explicitTarget =
        req.body.targetAccountId !== undefined
          ? req.body.targetAccountId
          : req.body.toAccountId;

      if (hasExplicitTarget && explicitTarget) {
        nextToAccountId = await resolvePaydownTargetId(
          explicitTarget,
          nextCategory,
          nextTitle,
          dbTx
        );
      } else if (hasExplicitTarget && !explicitTarget) {
        if (nextCategory === "Debt") {
          // User explicitly chose "General Debt Expense": do not re-link by name (B6)
          nextToAccountId = null;
        } else if (
          ["Credit Card Payment", "Savings Transfer", "Savings"].includes(
            nextCategory
          ) ||
          (trx.type === "TRANSFER" && nextCategory === trx.category)
        ) {
          // Preserve existing toAccountId for savings/card payments, and for transfers whose category is unchanged, when target is unset
          nextToAccountId = trx.toAccountId;
        } else {
          nextToAccountId = null;
        }
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
      const isDebtPayment =
        targetAccount && targetAccount.type === "DEBT";

      // A former card/debt payment that no longer targets any account becomes ordinary spending.
      // Other transfers (e.g. savings contributions) keep their type (C4).
      let wasPaydown = false;
      if (trx.type === "TRANSFER" && trx.toAccountId && !nextToAccountId) {
        const prevTarget = await Account.findByPk(trx.toAccountId, {
          transaction: dbTx,
        });
        wasPaydown = Boolean(
          prevTarget && ["CREDIT_CARD", "DEBT"].includes(prevTarget.type)
        );
      }

      const nextType =
        isCreditCardPayment || isDebtPayment
          ? "TRANSFER"
          : req.body.type
          ? String(req.body.type).toUpperCase()
          : wasPaydown
          ? "EXPENSE"
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
      } else if (!trx.recurringGroupId) {
        nextRecurringGroupId = null;
      }

      const prevRecurrence = trx.recurrence;
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

      // Stopping a recurring series (B3): the generator follows the newest row of a series, which is
      // usually an already-generated future row. When the *current* occurrence (the newest row dated
      // today or earlier, or the first row if none has come due) is set to "none", the series ends:
      // its unpaid rows after this one are removed and the rest marked non-recurring. Setting any
      // other occurrence to "none" changes only that row; it keeps its series id so generation
      // does not recreate it.
      let seriesEnded = false;
      let removedUpcomingCount = 0;
      let removedUpcomingTotal = 0;
      const wasRecurring = prevRecurrence && prevRecurrence !== "none";
      if (wasRecurring && nextRecurrence === "none" && nextRecurringGroupId) {
        const todayStr = getTodayString();
        const currentOccurrence =
          (await Transaction.findOne({
            where: {
              recurringGroupId: nextRecurringGroupId,
              date: { [Op.lte]: todayStr },
            },
            order: [
              ["date", "DESC"],
              ["createdAt", "DESC"],
            ],
            transaction: dbTx,
          })) ||
          (await Transaction.findOne({
            where: { recurringGroupId: nextRecurringGroupId },
            order: [
              ["date", "ASC"],
              ["createdAt", "ASC"],
            ],
            transaction: dbTx,
          }));

        if (currentOccurrence && currentOccurrence.id === trx.id) {
          seriesEnded = true;
          const upcoming = await Transaction.findAll({
            where: {
              recurringGroupId: nextRecurringGroupId,
              id: { [Op.ne]: trx.id },
              isCleared: false,
              date: { [Op.gt]: trx.date },
            },
            attributes: ["id", "amount"],
            transaction: dbTx,
          });
          removedUpcomingCount = upcoming.length;
          removedUpcomingTotal =
            Math.round(upcoming.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0) * 100) / 100;
          // Generated upcoming rows are removed for good, not sent to the Trash: restoring one would
          // restart the series it belonged to
          if (upcoming.length > 0) {
            await Transaction.destroy({
              where: { id: { [Op.in]: upcoming.map((r) => r.id) } },
              force: true,
              transaction: dbTx,
            });
          }
          // Rows of the series already in the Trash stop recurring too, so restoring one later
          // does not bring the series back
          await Transaction.update(
            { recurrence: "none" },
            {
              where: {
                recurringGroupId: nextRecurringGroupId,
                id: { [Op.ne]: trx.id },
              },
              paranoid: false,
              transaction: dbTx,
            }
          );
        }
      }

      // Apply updated transaction's effect on linked account, preserving applied status if it had already been applied
      // or if transitioning from unpaid to paid (e.g. overdue bill paid manually)
      await adjustAccountForTransaction(
        trx,
        1,
        dbTx,
        wasBalanceApplied || (!wasCleared && nextIsCleared)
      );
      await assertArchivedBalancesUnchanged(archivedBefore, dbTx);

      updated = { ...trx.toJSON(), seriesEnded, removedUpcomingCount, removedUpcomingTotal };
      if (dryRun) {
        await dbTx.rollback();
        return res.json({ ...updated, dryRun: true });
      }
      await dbTx.commit();
    } catch (error) {
      if (!dbTx.finished) await dbTx.rollback();
      throw error;
    }

    if (req.body.recurrence && req.body.recurrence !== "none") {
      await generateAfterSave();
    }
    res.json(updated);
  })
);

router.post(
  "/expenses/bulk-delete",
  validateBody(schemas.bulkDelete),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const { ids } = req.body;

      const toDelete = await Transaction.findAll({
        where: { id: { [Op.in]: ids } },
        transaction: dbTx,
      });

      // Balances come off now; the rows go to the Trash and POST /expenses/restore brings them back
      const deletedCount = await softDeleteTransactions(toDelete, dbTx);

      await dbTx.commit();
      res.json({ deletedCount, ids: toDelete.map((t) => t.id) });
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

      await softDeleteTransactions([trx], dbTx);

      await dbTx.commit();
      res.status(204).send();
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

// Trash: deleted rows (purged 30 days after their delete), newest delete first
router.get(
  "/expenses/trash",
  asyncHandler(async (req, res) => {
    res.json(await listTrash());
  })
);

// Undo / Restore from Trash: brings rows back and re-applies the balance their delete took off
router.post(
  "/expenses/restore",
  validateBody(schemas.restoreExpenses),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    let restored;
    try {
      restored = await restoreTransactions(req.body.ids, dbTx);
      await dbTx.commit();
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
    // A restored row may be the newest of a series again (runs after commit, like every save)
    if (restored.some((t) => t.recurrence && t.recurrence !== "none")) {
      await generateAfterSave();
    }
    res.json({ restoredCount: restored.length, ids: restored.map((t) => t.id) });
  })
);

module.exports = router;
