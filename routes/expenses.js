const express = require("express");
// Make sure to import the CreditCard model
const { Expense, Debt, CreditCard } = require("../models");
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

// No changes needed for this route
router.get("/expenses/monthly", async (req, res) => {
  try {
    const { year, month, sortBy = "due_date", sortOrder = "ASC" } = req.query;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    // Validate sortBy to prevent SQL injection
    const allowedSortBy = ["due_date", "name", "amount"];
    if (!allowedSortBy.includes(sortBy)) {
      return res.status(400).json({ error: "Invalid sort parameter." });
    }

    const expenses = await Expense.findAll({
      where: {
        due_date: {
          [Op.between]: [startDate, endDate],
        },
      },
      // Use the query parameters to order the results
      order: [[sortBy, sortOrder.toUpperCase()]],
    });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- NEW ROUTE for fetching expenses by category ---
router.get("/expenses/category", async (req, res) => {
  try {
    const { year, month, category } = req.query;
    if (!year || !month || !category) {
      return res
        .status(400)
        .json({ error: "Year, month, and category are required." });
    }

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const expenses = await Expense.findAll({
      where: {
        category: category,
        due_date: {
          [Op.between]: [startDate, endDate],
        },
      },
      order: [["due_date", "ASC"]],
    });
    res.json(expenses);
  } catch (error) {
    console.error("Error fetching expenses by category:", error);
    res.status(500).json({ error: error.message });
  }
});

// NEW: Full ledger — all income + all expenses combined, sorted by date DESC
router.get("/expenses/all", async (req, res) => {
  const { Paycheque } = require("../models");
  try {
    const [expenses, paycheques] = await Promise.all([
      Expense.findAll({ order: [["due_date", "DESC"]] }),
      Paycheque.findAll({ order: [["payment_date", "DESC"]] }),
    ]);

    const expenseRows = expenses.map((e) => ({
      id: e.id,
      type: "expense",
      name: e.name,
      amount: parseFloat(e.amount),
      date: e.due_date,
      category: e.category || "Other",
      is_paid: e.is_paid,
    }));

    const incomeRows = paycheques.map((p) => ({
      id: p.id,
      type: "income",
      name: p.name,
      amount: parseFloat(p.amount),
      date: p.payment_date,
      category: "Income",
      is_paid: true,
    }));

    const combined = [...expenseRows, ...incomeRows].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json(combined);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MODIFIED: This route defers credit card balance updates if future-dated
router.post("/expenses", async (req, res) => {
  try {
    const { amount, creditCardId, due_date } = req.body;
    
    const todayStr = getTodayString();
    const isCreditCard = !!creditCardId;
    const isPastOrPresent = due_date <= todayStr;
    
    // Only auto-mark as paid if it's a credit card expense and the date has arrived
    if (isCreditCard && isPastOrPresent) {
        req.body.is_paid = true;
    } else {
        req.body.is_paid = req.body.is_paid || false;
    }

    const newExpense = await Expense.create(req.body);

    // Only apply to balance if the date has natively arrived
    if (creditCardId && isPastOrPresent) {
      const card = await CreditCard.findByPk(creditCardId);
      if (card) {
        card.currentBalance =
          parseFloat(card.currentBalance) + parseFloat(amount);
        await card.save();
      }
    }

    res.status(201).json(newExpense);
  } catch (error) {
    console.error("Error creating expense:", error);
    res.status(400).json({ error: error.message });
  }
});

// MODIFIED: Perfect State Machine for Edit Deltas
router.put("/expenses/:id", async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (!expense) {
      return res.status(404).send("Expense not found");
    }

    const oldIsPaid = expense.is_paid;
    const oldAmount = parseFloat(expense.amount || 0);
    const oldCardId = expense.creditCardId;

    const newAmount = req.body.amount !== undefined ? parseFloat(req.body.amount) : oldAmount;
    const newCardId = req.body.creditCardId !== undefined ? (req.body.creditCardId || null) : oldCardId;
    
    // User might manually send `is_paid: true` by clicking "Mark as Paid"
    let newIsPaid = req.body.is_paid !== undefined ? req.body.is_paid : oldIsPaid;
    
    // If they changed the due_date to past/present on a credit card, enforce is_paid cleanly
    if (req.body.due_date && newCardId) {
        const todayStr = getTodayString();
        if (req.body.due_date <= todayStr) {
            newIsPaid = true;
            req.body.is_paid = true;
        } else if (req.body.due_date > todayStr && req.body.is_paid === undefined) {
            // if moving to future and not explicitly marking paid manually
            newIsPaid = false;
            req.body.is_paid = false;
        }
    }

    // STATE CHANGE REVERSION:
    // If it historically affected a card balance, revert it first.
    if (oldCardId && oldIsPaid) {
        const oldCard = await CreditCard.findByPk(oldCardId);
        if (oldCard) {
            oldCard.currentBalance = parseFloat(oldCard.currentBalance) - oldAmount;
            await oldCard.save();
        }
    }
    
    // STATE CHANGE APPLICATION:
    // If it newly affects a card balance, apply it now.
    if (newCardId && newIsPaid) {
        const newCard = await CreditCard.findByPk(newCardId);
        if (newCard) {
            newCard.currentBalance = parseFloat(newCard.currentBalance) + newAmount;
            await newCard.save();
        }
    }

    await expense.update(req.body);
    res.json(expense);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// MODIFIED: This route only reverts balance if it was officially applied already
router.delete("/expenses/:id", async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (expense) {
      // If the expense was successfully applied to a credit card, revert it.
      if (expense.creditCardId && expense.is_paid) {
        const card = await CreditCard.findByPk(expense.creditCardId);
        if (card) {
          card.currentBalance =
            parseFloat(card.currentBalance) - parseFloat(expense.amount);
          await card.save();
        }
      }

      await expense.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Expense not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
