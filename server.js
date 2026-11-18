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
const { sequelize } = require("./models");
const cron = require("node-cron");
const { assertAuthConfiguration } = require("./config/auth");
const { runDailySweep } = require("./services/dailySweepService");
const { getPrimaryCheckingAccount } = require("./services/checkingService");
const { runDebtPaymentCategoryMigration } = require("./services/debtPaymentCategoryService");
const authRoutes = require("./routes/auth");
const expenseRoutes = require("./routes/expenses");
const debtRoutes = require("./routes/debts");
const savingsGoalRoutes = require("./routes/savingsGoals");
const dashboardRoutes = require("./routes/dashboard");
const geminiRoutes = require("./routes/gemini");
const creditCardRoutes = require("./routes/creditCards");
const paychequeRoutes = require("./routes/paycheques");
const cronRoutes = require("./routes/cron");
const exportRoutes = require("./routes/export");
const budgetRoutes = require("./routes/budgets");
const forecastRoutes = require("./routes/forecast");
const settingsRoutes = require("./routes/settings");
const netWorthHistoryRoutes = require("./routes/netWorthHistory");
const subscriptionRoutes = require("./routes/subscriptions");
const accountRoutes = require("./routes/accounts");
const ruleRoutes = require("./routes/rules");
const importRoutes = require("./routes/import");
const alertRoutes = require("./routes/alerts");
const reportRoutes = require("./routes/reports");
const {
  router: recurringRoutes,
  createRecurringExpenses,
  runSeriesEndMigration,
  runLegacySeriesIdMigration,
} = require("./routes/recurring");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const {
  loginLimiter,
  apiLimiter,
  aiLimiter,
} = require("./middleware/rateLimit");

const app = express();
app.set("trust proxy", 1);
// Don't advertise Express, and stop browsers guessing a response's type (S-headers)
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
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
      const corsError = new Error("Not allowed by CORS");
      corsError.status = 403;
      callback(corsError);
    }
  },
  methods: "GET,POST,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization",
  // Lets the app read the CSV download's file name
  exposedHeaders: "Content-Disposition",
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
app.use("/api/categorize-receipt", aiLimiter);
app.use("/api/chat-advisor", aiLimiter);
app.use("/api/reports/month-close/commentary", aiLimiter);
app.use("/api", apiLimiter);

// --- HEALTH CHECK ---
app.get("/api/health", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  const hasAi = Boolean(process.env.GEMINI_API_KEY);
  if (isProd) {
    return res.json({ status: "ok", ai: hasAi });
  }
  res.json({
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    dialect: sequelize.getDialect(),
    isProductionDb: Boolean(sequelize.isProductionDb),
    ai: hasAi,
  });
});

// --- API ROUTES ---
app.use("/api/auth", authRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api", cronRoutes);
app.use("/api/recurring", recurringRoutes);
app.use("/api", expenseRoutes);
app.use("/api", debtRoutes);
app.use("/api", savingsGoalRoutes);
app.use("/api", dashboardRoutes);
app.use("/api", geminiRoutes);
app.use("/api", creditCardRoutes);
app.use("/api", accountRoutes);
app.use("/api", paychequeRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/forecast", forecastRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/net-worth-history", netWorthHistoryRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/rules", ruleRoutes);
app.use("/api/import", importRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/reports", reportRoutes);

// --- 404 & CENTRAL ERROR HANDLING ---
app.use(notFoundHandler);
app.use(errorHandler);

// --- Schedulers (Long-lived server environments) ---
// The backend is hosted on Render. The nightly GitHub Actions workflow is the primary trigger
// because the free instance sleeps; node-cron is a backup while the instance is awake.
// Set ENABLE_IN_PROCESS_CRON=false to rely on the workflow alone. Overlapping runs are safe:
// the sweep takes a database advisory lock and recurring rows have a unique (group, date) index.
const startSchedulers = () => {
  if (process.env.ENABLE_IN_PROCESS_CRON === "false") {
    console.log("In-process cron disabled (ENABLE_IN_PROCESS_CRON=false).");
    return;
  }

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
};

// --- Initialize Server ---
async function initialize() {
  try {
    assertAuthConfiguration();

    const syncOptions =
      process.env.DB_ALTER_SYNC === "true" ||
      (process.env.NODE_ENV !== "production" &&
        sequelize.getDialect() !== "sqlite")
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
      if (!tableDesc.balanceApplied) {
        await queryInterface.addColumn("Transactions", "balanceApplied", {
          type: DataTypes.BOOLEAN,
          defaultValue: false,
        });
      }
      if (!tableDesc.recurringGroupId) {
        await queryInterface.addColumn("Transactions", "recurringGroupId", {
          type: DataTypes.UUID,
          allowNull: true,
        });
      }
      if (!tableDesc.clientRef) {
        await queryInterface.addColumn("Transactions", "clientRef", {
          type: DataTypes.UUID,
          allowNull: true,
        });
      }
      // Trash (soft delete): deletedAt must exist before any query below, since the model is paranoid
      if (!tableDesc.deletedAt) {
        await queryInterface.addColumn("Transactions", "deletedAt", {
          type: DataTypes.DATE,
          allowNull: true,
        });
      }
      // Bank CSV import: imported rows wait in the "Review new" inbox
      if (!tableDesc.needsReview) {
        await queryInterface.addColumn("Transactions", "needsReview", {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        });
      }
      if (!tableDesc.balanceReversedOnDelete) {
        await queryInterface.addColumn("Transactions", "balanceReversedOnDelete", {
          type: DataTypes.BOOLEAN,
          defaultValue: false,
        });
      }
      // Notes and tags on a transaction (F11)
      if (!tableDesc.notes) {
        await queryInterface.addColumn("Transactions", "notes", {
          type: DataTypes.TEXT,
          allowNull: true,
        });
      }
      if (!tableDesc.tags) {
        await queryInterface.addColumn("Transactions", "tags", {
          type: DataTypes.JSON,
          allowNull: true,
        });
      }

      // Safely ensure registered account columns exist on Accounts (Phase J)
      try {
        const accountTableDesc = await queryInterface.describeTable("Accounts");
        if (!accountTableDesc.registeredType) {
          await queryInterface.addColumn("Accounts", "registeredType", {
            type: DataTypes.STRING,
            allowNull: true,
          });
        }
        if (!accountTableDesc.contributionRoom) {
          await queryInterface.addColumn("Accounts", "contributionRoom", {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
          });
        }
        if (!accountTableDesc.roomYear) {
          await queryInterface.addColumn("Accounts", "roomYear", {
            type: DataTypes.INTEGER,
            allowNull: true,
          });
        }
        // Debt due-date anchor day (R3)
        if (!accountTableDesc.dueDay) {
          await queryInterface.addColumn("Accounts", "dueDay", {
            type: DataTypes.INTEGER,
            allowNull: true,
          });
        }
        // Card statement cycles
        if (!accountTableDesc.statementDay) {
          await queryInterface.addColumn("Accounts", "statementDay", {
            type: DataTypes.INTEGER,
            allowNull: true,
          });
        }
        // Sinking funds: a goal's linked bill
        if (!accountTableDesc.linkedRecurringGroupId) {
          await queryInterface.addColumn("Accounts", "linkedRecurringGroupId", {
            type: DataTypes.UUID,
            allowNull: true,
          });
        }
      } catch (accColErr) {
        console.warn("⚠️ Could not verify/add Accounts columns:", accColErr.message);
      }
      // Safely ensure unique index on (recurringGroupId, date) exists
      try {
        const existingIndexes = await queryInterface.showIndex("Transactions");
        const hasRecurringDateIndex = existingIndexes.some(
          (idx) => idx.name === "transactions_recurring_group_date_unique"
        );
        if (!hasRecurringDateIndex) {
          await queryInterface.addIndex(
            "Transactions",
            ["recurringGroupId", "date"],
            {
              unique: true,
              name: "transactions_recurring_group_date_unique",
            }
          );
          console.log(
            "✅ Added unique index transactions_recurring_group_date_unique on (recurringGroupId, date)."
          );
        }
      } catch (idxErr) {
        console.warn(
          "⚠️ Could not create recurring unique index (existing duplicates may need manual cleanup):",
          idxErr.message
        );
      }

      // Safely ensure unique index on Transactions (clientRef) exists (Phase L)
      try {
        const existingIndexes = await queryInterface.showIndex("Transactions");
        const hasClientRefIndex = existingIndexes.some(
          (idx) => idx.name === "transactions_client_ref_unique"
        );
        if (!hasClientRefIndex) {
          await queryInterface.addIndex("Transactions", ["clientRef"], {
            unique: true,
            name: "transactions_client_ref_unique",
          });
          console.log("✅ Added unique index transactions_client_ref_unique on (clientRef).");
        }
      } catch (idxErr) {
        console.warn("⚠️ Could not create clientRef unique index:", idxErr.message);
      }

      // Safely ensure unique index on NetWorthSnapshots (date) exists
      try {
        const snapshotIndexes = await queryInterface.showIndex("NetWorthSnapshots");
        const hasSnapshotDateIndex = snapshotIndexes.some(
          (idx) =>
            idx.name === "net_worth_snapshots_date_unique" ||
            idx.fields?.some((f) => f.attribute === "date")
        );
        if (!hasSnapshotDateIndex) {
          await queryInterface.addIndex("NetWorthSnapshots", ["date"], {
            unique: true,
            name: "net_worth_snapshots_date_unique",
          });
          console.log("✅ Added unique index on NetWorthSnapshots(date).");
        }
      } catch (snapIdxErr) {
        // SQLite sync creates unique indexes automatically from model
      }

    } catch (migErr) {
      console.warn("Transactions schema/backfill notice:", migErr.message);
    }

    // One-off: debt payments saved with the purchase category "Debt" become "Debt Payment"
    // (Setting debt_payment_category_v1, one transaction with the flag)
    try {
      const relabelled = await runDebtPaymentCategoryMigration();
      if (relabelled !== null) {
        console.log(`✅ Relabelled ${relabelled} debt payments from "Debt" to "Debt Payment".`);
      }
    } catch (catErr) {
      console.error("❌ Debt payment category migration failed; it will retry on the next start:", catErr);
    }

    // One-off: older series had no recurringGroupId and were grouped by type and title. Each one gets
    // a series id (all of its rows, Trash included), in one transaction with its Setting flag. It runs
    // first, with its own try: the series-end migration groups by id only, so it waits for this one,
    // and until both flags are set the generator does not run (it logs a warning).
    let legacySeriesIdsDone = false;
    try {
      const assigned = await runLegacySeriesIdMigration();
      if (assigned !== null) {
        console.log(
          `✅ Assigned series IDs to ${assigned.seriesCount} old series (${assigned.rowCount} rows; ${assigned.joinedExistingCount} joined an existing series${
            assigned.joinedEndedCount > 0 ? `, ${assigned.joinedEndedCount} of them ended, so their rows are One-time` : ""
          }).`
        );
        // A row on the same date as one that joined its series (unique index) stays a single row; a
        // recurring one is set to One-time so it is not charged as a second series
        for (const row of assigned.leftOut) {
          console.log(
            `   ${row.title} ${row.date} $${row.amount.toFixed(2)} (kept as a single row${
              row.setToOneTime ? ", set to One-time" : ""
            })`
          );
        }
      }
      legacySeriesIdsDone = true;
    } catch (legacyErr) {
      console.error(
        "❌ Series-ID migration failed; recurring generation stays off until it succeeds:",
        legacyErr
      );
    }

    // One-off: a series used to stop when its newest row was set to One-time. The generator now
    // skips One-time rows, so series stopped that way are ended explicitly, in one transaction with
    // its Setting flag. It has its own try so an earlier backfill failure cannot skip it; until the
    // flag is set the generator does not run (it logs a warning).
    if (legacySeriesIdsDone) {
      try {
        const endedTitles = await runSeriesEndMigration();
        if (endedTitles !== null) {
          console.log(
            `✅ Series-end migration: ended ${endedTitles.length} recurring series whose newest row was One-time${
              endedTitles.length > 0 ? `: ${endedTitles.join(", ")}` : ""
            }.`
          );
        }
      } catch (seriesErr) {
        console.error(
          "❌ Series-end migration failed; recurring generation stays off until it succeeds:",
          seriesErr
        );
      }
    }

    await getPrimaryCheckingAccount();
  } catch (error) {
    console.error("❌ Unable to initialize the server:", error);
    throw error;
  }
}

async function start() {
  try {
    await initialize();
  } catch {
    process.exit(1);
  }
  startSchedulers();
  app.listen(port, () => {
    console.log(`🚀 Server is running on http://localhost:${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, initialize, start };
