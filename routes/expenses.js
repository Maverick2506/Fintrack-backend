const express = require("express");
const { sequelize, Transaction, Account } = require("../models");
const { Op } = require("sequelize");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

// Helper to format YYYY-MM-DD month boundaries cleanly
const getMonthDateRange = (year, month) => {
  const y = parseInt(year);
  const m = parseInt(month);
  const startDate = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { startDate, endDate };
};

// Apply or reverse balance effect of a transaction on linked non-checking accounts
const adjustAccountForTransaction = async (trx, direction = 1, dbTx = null) => {
  const amount = parseFloat(trx.amount) || 0;
  if (amount === 0) return;

  // 1. Cleared expense charged to a Credit Card increases card balance (+amount)
  if (trx.type === "EXPENSE" && trx.isCleared && trx.fromAccountId) {
    const fromAcc = await Account.findByPk(trx.fromAccountId, { transaction: dbTx });
    if (fromAcc && fromAcc.type === "CREDIT_CARD") {
      const nextBal = Math.max(0, parseFloat(fromAcc.initialBalance || 0) + direction * amount);
      fromAcc.initialBalance = nextBal;
      await fromAcc.save({ transaction: dbTx });
    }
  }

  // 2. Transfer to a Debt, Credit Card, or Savings Goal
  if (trx.type === "TRANSFER" && trx.toAccountId) {
    const toAcc = await Account.findByPk(trx.toAccountId, { transaction: dbTx });
    if (toAcc) {
      if (toAcc.type === "CREDIT_CARD" || toAcc.type === "DEBT") {
        // Payment reduces debt/card balance when applied (direction=1), restores when reversed (direction=-1)
        const nextBal = Math.max(0, parseFloat(toAcc.initialBalance || 0) - direction * amount);
        toAcc.initialBalance = nextBal;
        await toAcc.save({ transaction: dbTx });
      } else if (toAcc.type === "SAVINGS_GOAL") {
        // Contribution increases savings balance when applied (direction=1), reduces when reversed (direction=-1)
        const nextBal = Math.max(0, parseFloat(toAcc.initialBalance || 0) + direction * amount);
        toAcc.initialBalance = nextBal;
        await toAcc.save({ transaction: dbTx });
      }
    }
  }
};

// Map old "monthly expenses" API shape
router.get("/expenses/monthly", async (req, res) => {
  try {
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
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Category drill-down endpoint for ReportsPage pie chart
router.get("/expenses/category", async (req, res) => {
  try {
    const { year, month, category } = req.query;
    if (!year || !month || !category) {
      return res
        .status(400)
        .json({ error: "year, month, and category are required." });
    }
    const { startDate, endDate } = getMonthDateRange(year, month);

    const expenses = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        category,
        date: { [Op.between]: [startDate, endDate] },
      },
      order: [["date", "ASC"]],
    });

    const formatted = expenses.map((e) => ({
      ...e.toJSON(),
      due_date: e.date,
      name: e.title,
      is_paid: e.isCleared,
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Full ledger: Transactions of ALL types combined natively
router.get("/expenses/all", async (req, res) => {
  try {
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
      recurrence: t.recurrence || "none",
      creditCardId:
        t.fromAccount && t.fromAccount.type === "CREDIT_CARD"
          ? t.fromAccount.id
          : null,
      fromAccount: t.fromAccount ? t.fromAccount.name : null,
      toAccount: t.toAccount ? t.toAccount.name : null,
    }));

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/expenses", async (req, res) => {
  const dbTx = await sequelize.transaction();
  try {
    const {
      name,
      amount,
      due_date,
      category,
      is_paid,
      creditCardId,
      recurrence,
    } = req.body;
    let [fromAccount] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
      transaction: dbTx,
    });
    if (creditCardId) {
      const cardAccount = await Account.findByPk(creditCardId, {
        transaction: dbTx,
      });
      if (cardAccount) fromAccount = cardAccount;
    }

    const newExp = await Transaction.create(
      {
        title: name,
        amount: parseFloat(amount),
        date: due_date,
        type: "EXPENSE",
        category: category || "Other",
        isCleared: Boolean(is_paid),
        recurrence: recurrence || "none",
        fromAccountId: fromAccount.id,
      },
      { transaction: dbTx }
    );

    // If paid immediately on a credit card, increment the card balance
    await adjustAccountForTransaction(newExp, 1, dbTx);

    await dbTx.commit();
    res.status(201).json(newExp);
  } catch (error) {
    await dbTx.rollback();
    res.status(400).json({ error: error.message });
  }
});

router.put("/expenses/:id", async (req, res) => {
  const dbTx = await sequelize.transaction();
  try {
    const trx = await Transaction.findByPk(req.params.id, {
      transaction: dbTx,
    });
    if (!trx) {
      await dbTx.rollback();
      return res.status(404).send("Transaction not found");
    }

    // Reverse old transaction's effect on any linked credit card / account
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

    await trx.update(
      {
        title: req.body.name || trx.title,
        amount:
          req.body.amount !== undefined
            ? parseFloat(req.body.amount)
            : trx.amount,
        date: req.body.due_date || req.body.payment_date || trx.date,
        category: req.body.category || trx.category,
        isCleared:
          req.body.is_paid !== undefined ? Boolean(req.body.is_paid) : trx.isCleared,
        recurrence: req.body.recurrence || trx.recurrence,
        fromAccountId,
      },
      { transaction: dbTx }
    );

    // Apply updated transaction's effect on linked credit card / account
    await adjustAccountForTransaction(trx, 1, dbTx);

    await dbTx.commit();
    res.json(trx);
  } catch (error) {
    await dbTx.rollback();
    res.status(400).json({ error: error.message });
  }
});

router.post("/expenses/bulk-delete", async (req, res) => {
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
    res.status(500).json({ error: error.message });
  }
});

router.delete("/expenses/:id", async (req, res) => {
  const dbTx = await sequelize.transaction();
  try {
    const trx = await Transaction.findByPk(req.params.id, {
      transaction: dbTx,
    });
    if (!trx) {
      await dbTx.rollback();
      return res.status(404).send("Not found");
    }

    await adjustAccountForTransaction(trx, -1, dbTx);
    await trx.destroy({ transaction: dbTx });

    await dbTx.commit();
    res.status(204).send();
  } catch (error) {
    await dbTx.rollback();
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
