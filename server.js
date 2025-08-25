const express = require("express");
const cors = require("cors");
const {
  sequelize,
  Paycheque,
  Expense,
  Debt,
  SavingsGoal,
} = require("./models");
const { Op } = require("sequelize");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
const port = process.env.PORT || 8000;

app.use(express.json());

// --- SECRETS FROM ENVIRONMENT VARIABLES ---
const SUPER_SECRET_PASSWORD = process.env.SUPER_SECRET_PASSWORD;

// --- AUTH MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SUPER_SECRET_PASSWORD);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
};

// --- AUTH ENDPOINT ---
app.post("/api/auth/login", async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== SUPER_SECRET_PASSWORD) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const token = jwt.sign({ user: "Maverick" }, SUPER_SECRET_PASSWORD, {
      expiresIn: "1d",
    });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: "Server error during login." });
  }
});

// --- PROTECTED DATA ROUTES ---

// Paycheque Endpoints
app.post("/api/paycheques", authMiddleware, async (req, res) => {
  try {
    const newPaycheque = await Paycheque.create(req.body);
    res.status(201).json(newPaycheque);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Expense Endpoints
app.get("/api/expenses/monthly", authMiddleware, async (req, res) => {
  try {
    const { year, month } = req.query;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const expenses = await Expense.findAll({
      where: {
        due_date: {
          [Op.between]: [startDate, endDate],
        },
      },
      order: [["due_date", "ASC"]],
    });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/expenses", authMiddleware, async (req, res) => {
  try {
    const newExpense = await Expense.create({ ...req.body, is_paid: false });
    res.status(201).json(newExpense);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/expenses/:id", authMiddleware, async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (expense) {
      await expense.update(req.body);
      res.json(expense);
    } else {
      res.status(404).send("Expense not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/expenses/:id", authMiddleware, async (req, res) => {
  try {
    const expense = await Expense.findByPk(req.params.id);
    if (expense) {
      await expense.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Expense not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debt Endpoints
app.get("/api/debts", authMiddleware, async (req, res) => {
  try {
    const debts = await Debt.findAll();
    res.json(debts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/debts", authMiddleware, async (req, res) => {
  try {
    const { name, total_amount, monthly_payment } = req.body;
    const newDebt = await Debt.create({
      name,
      total_amount,
      total_remaining: total_amount,
      monthly_payment,
    });
    res.status(201).json(newDebt);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/debts/:id/pay", authMiddleware, async (req, res) => {
  try {
    const debt = await Debt.findByPk(req.params.id);
    if (debt) {
      const paymentAmount = parseFloat(req.body.amount);
      debt.total_remaining = parseFloat(debt.total_remaining) - paymentAmount;
      await debt.save();

      await Expense.create({
        name: `Payment for ${debt.name}`,
        amount: paymentAmount,
        due_date: new Date(),
        is_paid: true,
        category: "Debt",
      });

      res.json(debt);
    } else {
      res.status(404).send("Debt not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Savings Goal Endpoints
app.get("/api/savings-goals", authMiddleware, async (req, res) => {
  try {
    const goals = await SavingsGoal.findAll();
    res.json(goals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/savings-goals", authMiddleware, async (req, res) => {
  try {
    const newGoal = await SavingsGoal.create(req.body);
    res.status(201).json(newGoal);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post(
  "/api/savings-goals/:id/contribute",
  authMiddleware,
  async (req, res) => {
    try {
      const goal = await SavingsGoal.findByPk(req.params.id);
      if (goal) {
        goal.current_amount =
          parseFloat(goal.current_amount) + parseFloat(req.body.amount);
        await goal.save();
        res.json(goal);
      } else {
        res.status(404).send("Goal not found");
      }
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

// Dashboard & Reporting Endpoints
app.get("/api/dashboard", authMiddleware, async (req, res) => {
  try {
    const year = req.query.year
      ? parseInt(req.query.year)
      : new Date().getFullYear();
    const month = req.query.month
      ? parseInt(req.query.month) - 1
      : new Date().getMonth();
    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0);
    const today = new Date();

    const totalIncome = await Paycheque.sum("amount", {
      where: { payment_date: { [Op.between]: [startOfMonth, endOfMonth] } },
    });
    const totalSpending = await Expense.sum("amount", {
      where: {
        is_paid: true,
        due_date: { [Op.between]: [startOfMonth, endOfMonth] },
      },
    });
    const upcomingBills =
      month === new Date().getMonth() && year === new Date().getFullYear()
        ? await Expense.findAll({
            where: { is_paid: false, due_date: { [Op.gte]: today } },
            order: [["due_date", "ASC"]],
            limit: 5,
          })
        : [];

    const debtSummary = await Debt.findAll();
    const savingsSummary = await SavingsGoal.findAll();

    res.json({
      monthlySummary: {
        totalIncome: totalIncome || 0,
        totalSpending: totalSpending || 0,
        netFlow: (totalIncome || 0) - (totalSpending || 0),
      },
      upcomingBills,
      debtSummary,
      savingsSummary,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/spending-summary", authMiddleware, async (req, res) => {
  try {
    const year = req.query.year
      ? parseInt(req.query.year)
      : new Date().getFullYear();
    const month = req.query.month
      ? parseInt(req.query.month) - 1
      : new Date().getMonth();
    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0);

    const spendingByCategory = await Expense.findAll({
      attributes: [
        "category",
        [sequelize.fn("SUM", sequelize.col("amount")), "total_amount"],
      ],
      where: {
        is_paid: true,
        due_date: { [Op.between]: [startOfMonth, endOfMonth] },
      },
      group: ["category"],
      raw: true,
    });
    const formattedData = spendingByCategory.map((item) => ({
      name: item.category,
      value: parseFloat(item.total_amount),
    }));
    res.json(formattedData);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch spending summary." });
  }
});

// Gemini Endpoints
app.post("/api/financial-advice", authMiddleware, async (req, res) => {
  // ... your financial advice logic
});

app.post("/api/categorize-expense", authMiddleware, async (req, res) => {
  // ... your categorization logic
});

// --- Initialize Server ---
async function initialize() {
  try {
    await sequelize.sync({ alter: true });
    app.listen(port, () => {
      console.log(`🚀 Server is running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("❌ Unable to start the server:", error);
  }
}

initialize();
