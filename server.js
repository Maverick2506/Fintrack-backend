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
const { DataTypes } = require("sequelize");
const { sequelize, Account } = require("./models");
const cron = require("node-cron");
const { assertAuthConfiguration } = require("./config/auth");
const { runDailySweep } = require("./services/dailySweepService");
const authRoutes = require("./routes/auth");
const expenseRoutes = require("./routes/expenses");
const debtRoutes = require("./routes/debts");
const savingsGoalRoutes = require("./routes/savingsGoals");
const dashboardRoutes = require("./routes/dashboard");
const geminiRoutes = require("./routes/gemini");
const creditCardRoutes = require("./routes/creditCards");
const paychequeRoutes = require("./routes/paycheques");
const cronRoutes = require("./routes/cron");
const {
  router: recurringRoutes,
  createRecurringExpenses,
} = require("./routes/recurring");
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

// --- RATE LIMITERS ---
app.use("/api/auth/login", loginLimiter);
app.use("/api/financial-advice", aiLimiter);
app.use("/api/categorize-expense", aiLimiter);
app.use("/api", apiLimiter);

// --- API ROUTES ---
app.use("/api/auth", authRoutes);
app.use("/api", cronRoutes);
app.use("/api", expenseRoutes);
app.use("/api", debtRoutes);
app.use("/api", savingsGoalRoutes);
app.use("/api", dashboardRoutes);
app.use("/api", geminiRoutes);
app.use("/api", creditCardRoutes);
app.use("/api/recurring", recurringRoutes);
app.use("/api", paychequeRoutes);

// --- 404 & CENTRAL ERROR HANDLING ---
app.use(notFoundHandler);
app.use(errorHandler);

// --- Schedulers (Long-lived server environments) ---
cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      await runDailySweep();
    } catch (err) {
      console.error("Scheduled daily sweep error:", err);
    }
  },
  {
    timezone: "America/Toronto",
  }
);

cron.schedule(
  "0 1 * * *",
  async () => {
    try {
      await createRecurringExpenses();
    } catch (err) {
      console.error("Scheduled recurring generation error:", err);
    }
  },
  {
    timezone: "America/Toronto",
  }
);

// --- Initialize Server ---
async function initialize() {
  try {
    assertAuthConfiguration();

    const syncOptions =
      process.env.DB_ALTER_SYNC === "true" ||
      process.env.NODE_ENV !== "production"
        ? { alter: true }
        : undefined;
    await sequelize.sync(syncOptions);

    // Safely ensure tax-related columns exist on existing databases
    try {
      const queryInterface = sequelize.getQueryInterface();
      const tableDesc = await queryInterface.describeTable("Transactions");
      if (!tableDesc.baseAmount) {
        await queryInterface.addColumn("Transactions", "baseAmount", {
          type: DataTypes.DECIMAL(10, 2),
          allowNull: true,
        });
      }
      if (!tableDesc.isTaxExclusive) {
        await queryInterface.addColumn("Transactions", "isTaxExclusive", {
          type: DataTypes.BOOLEAN,
          defaultValue: false,
        });
      }
      if (!tableDesc.taxRate) {
        await queryInterface.addColumn("Transactions", "taxRate", {
          type: DataTypes.DECIMAL(5, 2),
          allowNull: true,
        });
      }
      if (!tableDesc.taxApplied) {
        await queryInterface.addColumn("Transactions", "taxApplied", {
          type: DataTypes.BOOLEAN,
          defaultValue: false,
        });
      }
    } catch (migErr) {
      console.warn("Transactions schema check notice:", migErr.message);
    }

    await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
    });
    app.listen(port, () => {
      console.log(`🚀 Server is running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("❌ Unable to start the server:", error);
    process.exit(1);
  }
}

initialize();
