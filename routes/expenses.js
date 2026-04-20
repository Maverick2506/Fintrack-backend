const express = require("express");
const { Transaction, Account } = require("../models");
const { Op } = require("sequelize");
const authMiddleware = require("../middleware/authMiddleware");
const { toZonedTime, format } = require("date-fns-tz");
const router = express.Router();

router.use(authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () => {
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    return format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
};

// Map old "monthly expenses" API shape exactly 
router.get("/expenses/monthly", async (req, res) => {
  try {
    const { year, month, sortBy = "date", sortOrder = "ASC" } = req.query;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const allowedSortBy = ["date", "title", "amount"];
    const sortField = sortBy === "due_date" || sortBy === "payment_date" ? "date" : 
                     sortBy === "name" ? "title" : sortBy;

    if (!allowedSortBy.includes(sortField)) {
        return res.status(400).json({ error: "Invalid sort parameter." });
    }

    const expenses = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        date: { [Op.between]: [startDate, endDate] },
      },
      order: [[sortField, sortOrder.toUpperCase()]],
    });

    const formatted = expenses.map(e => ({
       ...e.toJSON(),
       due_date: e.date,
       name: e.title,
       is_paid: e.isCleared
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
      order: [["date", "DESC"]],
      include: [
        { model: Account, as: 'fromAccount' },
        { model: Account, as: 'toAccount' }
      ]
    });

    const rows = all.map(t => ({
      id: t.id,
      type: t.type.toLowerCase(),
      name: t.title,
      amount: parseFloat(t.amount),
      date: t.date,
      category: t.category,
      is_paid: t.isCleared,
      fromAccount: t.fromAccount ? t.fromAccount.name : null,
      toAccount: t.toAccount ? t.toAccount.name : null
    }));
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/expenses", async (req, res) => {
  try {
    const { name, amount, due_date, category, is_paid, creditCardId, recurrence } = req.body;
    let fromAccount = await Account.findOne({ where: { name: "Primary Checking" } });
    if (creditCardId) {
        fromAccount = await Account.findByPk(creditCardId);
    }
    if (!fromAccount) throw new Error("Account not found");

    const newExp = await Transaction.create({
      title: name,
      amount: parseFloat(amount),
      date: due_date,
      type: "EXPENSE",
      category: category || "Other",
      isCleared: is_paid || false,
      recurrence: recurrence || "none",
      fromAccountId: fromAccount.id
    });
    
    res.status(201).json(newExp);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put("/expenses/:id", async (req, res) => {
  try {
    const trx = await Transaction.findByPk(req.params.id);
    if (!trx) return res.status(404).send("Transaction not found");

    await trx.update({
       title: req.body.name || trx.title,
       amount: req.body.amount || trx.amount,
       date: req.body.due_date || trx.date,
       category: req.body.category || trx.category,
       isCleared: req.body.is_paid !== undefined ? req.body.is_paid : trx.isCleared,
       recurrence: req.body.recurrence || trx.recurrence
    });
    res.json(trx);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/expenses/:id", async (req, res) => {
  try {
    const trx = await Transaction.findByPk(req.params.id);
    if (trx) {
      await trx.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
