const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const { sequelize, Transaction, Account } = require("./models");
const { Op } = require("sequelize");
const cron = require("node-cron");
const { toZonedTime, format } = require("date-fns-tz");
const authRoutes = require("./routes/auth");
const expenseRoutes = require("./routes/expenses");
const debtRoutes = require("./routes/debts");
const savingsGoalRoutes = require("./routes/savingsGoals");
const dashboardRoutes = require("./routes/dashboard");
const geminiRoutes = require("./routes/gemini");
const creditCardRoutes = require("./routes/creditCards");
const paychequeRoutes = require("./routes/paycheques");
const {
  router: recurringRoutes,
  createRecurringExpenses,
  getNextDueDate,
} = require("./routes/recurring");
const authMiddleware = require("./middleware/authMiddleware");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const {
  loginLimiter,
  apiLimiter,
  aiLimiter,
} = require("./middleware/rateLimit");

const app = express();
app.use(compression());

// --- CORS CONFIGURATION ---
const allowedOrigins = [
  "https://fintrack-frontend-jet.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: "GET,POST,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization",
  credentials: true,
};

app.use(cors(corsOptions));
// --- END CORS CONFIGURATION ---

const port = process.env.PORT || 8000;

app.use(express.json());

// --- API ROUTES ---
app.use("/api/auth/login", loginLimiter);
app.use("/api/financial-advice", aiLimiter);
app.use("/api/categorize-expense", aiLimiter);
app.use("/api", apiLimiter);

app.use("/api/auth", authRoutes);
app.use("/api", expenseRoutes);
app.use("/api", debtRoutes);
app.use("/api", savingsGoalRoutes);
app.use("/api", dashboardRoutes);
app.use("/api", geminiRoutes);
app.use("/api", creditCardRoutes);
app.use("/api/recurring", recurringRoutes);
app.use("/api", paychequeRoutes);

const runDailySweep = async () => {
  console.log("Running Daily Sweep (Credit Cards & Auto-Pay Debts)...");
  const dbTx = await sequelize.transaction();
  try {
    const TIMEZONE = "America/Toronto";
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    const todayString = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    // 1. Process Due Credit Card Expenses (pending bills charged to a credit card)
    const billsToUpdate = await Transaction.findAll({
      where: {
        isCleared: false,
        type: "EXPENSE",
        fromAccountId: { [Op.ne]: null },
        date: { [Op.lte]: todayString },
      },
      include: [
        {
          model: Account,
          as: "fromAccount",
          where: { type: "CREDIT_CARD" },
        },
      ],
      transaction: dbTx,
    });

    if (billsToUpdate.length > 0) {
      console.log(
        `Found ${billsToUpdate.length} credit card bill(s) to officially mark as paid.`
      );
      for (const bill of billsToUpdate) {
        if (bill.fromAccount) {
          bill.fromAccount.initialBalance =
            parseFloat(bill.fromAccount.initialBalance) +
            parseFloat(bill.amount);
          await bill.fromAccount.save({ transaction: dbTx });
        }
        bill.isCleared = true;
        await bill.save({ transaction: dbTx });
      }
    }

    // 2. Process Due Auto-Pay Debts
    const dueAutoPayDebts = await Account.findAll({
      where: {
        type: "DEBT",
        autoPay: true,
        dueDate: { [Op.lte]: todayString },
        initialBalance: { [Op.gt]: 0 },
      },
      transaction: dbTx,
    });

    if (dueAutoPayDebts.length > 0) {
      const [checking] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });

      for (const debt of dueAutoPayDebts) {
        const remaining = parseFloat(debt.initialBalance) || 0;
        const minPay = parseFloat(debt.minimumPayment) || 0;
        if (remaining <= 0 || minPay <= 0) continue;

        const paymentAmount = Math.min(remaining, minPay);
        debt.initialBalance = Math.max(0, remaining - paymentAmount);

        const currentDue = toZonedTime(`${debt.dueDate}T00:00:00`, TIMEZONE);
        const nextDue = getNextDueDate(
          currentDue,
          debt.paymentFrequency || "monthly"
        );
        if (nextDue && debt.initialBalance > 0) {
          debt.dueDate = format(nextDue, "yyyy-MM-dd", { timeZone: TIMEZONE });
        } else if (debt.initialBalance <= 0) {
          debt.autoPay = false;
        }

        await debt.save({ transaction: dbTx });

        await Transaction.create(
          {
            title: `Auto-Pay for ${debt.name}`,
            amount: paymentAmount,
            date: todayString,
            type: "TRANSFER",
            category: "Debt Payment",
            isCleared: true,
            fromAccountId: checking.id,
            toAccountId: debt.id,
          },
          { transaction: dbTx }
        );
      }
    }

    await dbTx.commit();
    return true;
  } catch (error) {
    await dbTx.rollback();
    console.error("Error running daily sweep:", error);
    throw error;
  }
};

app.get("/api/daily-check", authMiddleware, async (req, res) => {
  try {
    await runDailySweep();
    res.status(200).send("Daily check complete.");
  } catch (error) {
    res.status(500).send("Error in daily check.");
  }
});

app.use(notFoundHandler);
app.use(errorHandler);

// --- Automated Task Schedulers ---
cron.schedule(
  "0 0 * * *",
  async () => {
    await runDailySweep();
  },
  {
    timezone: "America/Toronto",
  }
);

// Runs at 1 AM EVERY DAY to create recurring expenses and paycheques ahead of time
cron.schedule("0 1 * * *", createRecurringExpenses, {
  timezone: "America/Toronto",
});
// --- END Automated Task Schedulers ---

// --- Initialize Server ---
async function initialize() {
  try {
    await sequelize.sync({ alter: true });
    await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
    });
    app.listen(port, () => {
      console.log(`🚀 Server is running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("❌ Unable to start the server:", error);
  }
}

initialize();
