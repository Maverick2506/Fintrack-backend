const express = require("express");
const cors = require("cors");
const compression = require("compression");
const { sequelize, Transaction, Account } = require("./models");
const { Op } = require("sequelize");
const { addDays, addMonths, addYears } = require("date-fns");
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
} = require("./routes/recurring");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const { apiLimiter, aiLimiter } = require("./middleware/rateLimit");

const app = express();
app.use(compression());

// --- CORS CONFIGURATION ---
const allowedOrigins = [
  "https://fintrack-frontend-jet.vercel.app",
  "http://localhost:5173",
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
  console.log("Running Daily Sweep (Credit Cards & Debts)...");
  try {
    const TIMEZONE = "America/Toronto";
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    const todayString = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    // 1. Process Due Credit Cards (Credit Card Expenses pending)
    const billsToUpdate = await Transaction.findAll({
      where: {
        isCleared: false,
        type: "EXPENSE",
        fromAccountId: { [Op.ne]: null },
        date: { [Op.lte]: todayString },
      },
      include: [{ model: Account, as: 'fromAccount', where: { type: 'CREDIT_CARD' } }]
    });

    if (billsToUpdate.length > 0) {
      console.log(`Found ${billsToUpdate.length} credit card bill(s) to officially mark as paid.`);
      for (const bill of billsToUpdate) {
        if (bill.fromAccount) {
           bill.fromAccount.initialBalance = parseFloat(bill.fromAccount.initialBalance) + parseFloat(bill.amount);
           await bill.fromAccount.save();
        }
        bill.isCleared = true;
        await bill.save();
      }
    }

    // 2. Process Auto-Pay Debts
    const debtsToUpdate = await Account.findAll({
      where: {
        type: "DEBT",
        dueDate: { [Op.lte]: todayString },
        initialBalance: { [Op.gt]: 0 },
      },
    });

    // NOTE: In V2, we would need an "autoPlay" flag on the Account, but for brevity assuming all active debts auto-sweep on due date if desired, or skip.
    // For V2 safety, I will skip generic sweeping on all debts and handle it strictly via explicit user actions until V3 updates form.
    return true;
  } catch (error) {
    console.error("Error running daily sweep:", error);
    throw error;
  }
};

app.get("/api/daily-check", async (req, res) => {
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
cron.schedule("0 0 * * *", async () => {
   await runDailySweep();
}, {
  timezone: "America/Toronto"
});

// This job runs at 1 AM EVERY DAY to create advanced recurring expenses strictly ahead of time.
cron.schedule("0 1 * * *", createRecurringExpenses, {
  timezone: "America/Toronto"
});
// --- END Automated Task Schedulers ---

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
