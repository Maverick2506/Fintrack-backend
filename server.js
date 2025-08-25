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
const { GoogleGenerativeAI } = require("@google/generative-ai");
const jwt = require("jsonwebtoken");

const app = express();

// --- CORS CONFIGURATION ---
const corsOptions = {
  origin: "https://fintrack-frontend-jet.vercel.app",
  optionsSuccessStatus: 200, // For legacy browser support
};
app.use(cors(corsOptions));
// --- END CORS CONFIGURATION ---

const port = process.env.PORT || 8000;

app.use(express.json());

// --- SECRETS FROM ENVIRONMENT VARIABLES ---
const SUPER_SECRET_PASSWORD = process.env.SUPER_SECRET_PASSWORD;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- GEMINI SETUP ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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
    const { name, amount, category } = req.body;

    if (category === "Debt") {
      const debt = await Debt.findOne({
        where: { name: name.replace("Payment for ", "") },
      });
      if (debt) {
        debt.total_remaining =
          parseFloat(debt.total_remaining) - parseFloat(amount);
        await debt.save();
      }
    }

    const newExpense = await Expense.create({ ...req.body, is_paid: true });
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

app.delete("/api/debts/:id", authMiddleware, async (req, res) => {
  try {
    const debt = await Debt.findByPk(req.params.id);
    if (debt) {
      await debt.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Debt not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
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

app.delete("/api/savings-goals/:id", authMiddleware, async (req, res) => {
  try {
    const goal = await SavingsGoal.findByPk(req.params.id);
    if (goal) {
      await goal.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Savings Goal not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
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
        due_date: { [Op.between]: [startOfMonth, endOfMonth] },
      },
    });
    const upcomingBills = await Expense.findAll({
      where: { is_paid: false, due_date: { [Op.gte]: today } },
      order: [["due_date", "ASC"]],
      limit: 5,
    });

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
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const prompt = `Based on the following financial data, provide a short, actionable financial tip for a user named Maverick: ${JSON.stringify(
      req.body
    )}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ advice: response.text() });
  } catch (error) {
    console.error("Gemini financial advice error:", error);
    res.status(500).json({ error: "Failed to generate financial advice." });
  }
});

app.post("/api/categorize-expense", authMiddleware, async (req, res) => {
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const prompt = `Categorize the following expense into one of these categories: Essentials, Subscription, Debt, Food & Drink, Transportation, Entertainment, Shopping, Other. Expense: "${req.body.name}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ category: response.text() });
  } catch (error) {
    console.error("Gemini categorization error:", error);
    res.status(500).json({ error: "Failed to categorize expense." });
  }
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
