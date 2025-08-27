const express = require("express");
const cors = require("cors");
const { sequelize, Expense } = require("./models");
const { Op } = require("sequelize");
const cron = require("node-cron");
const authRoutes = require("./routes/auth");
const expenseRoutes = require("./routes/expenses");
const debtRoutes = require("./routes/debts");
const savingsGoalRoutes = require("./routes/savingsGoals");
const dashboardRoutes = require("./routes/dashboard");
const geminiRoutes = require("./routes/gemini");
const creditCardRoutes = require("./routes/creditCards");

const app = express();

// --- NEW, MORE ROBUST CORS CONFIGURATION ---
const allowedOrigins = [
  "https://fintrack-frontend-jet.vercel.app",
  "http://localhost:5173", // Also allow your local development server
];

const corsOptions = {
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg =
        "The CORS policy for this site does not " +
        "allow access from the specified Origin.";
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: "GET,POST,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization",
  credentials: true,
  optionsSuccessStatus: 200, // For legacy browser support
};

app.use(cors(corsOptions));
// --- END CORS CONFIGURATION ---

const port = process.env.PORT || 8000;

app.use(express.json());

// --- API ROUTES ---
app.use("/api/auth", authRoutes);
app.use("/api", expenseRoutes);
app.use("/api", debtRoutes);
app.use("/api", savingsGoalRoutes);
app.use("/api", dashboardRoutes);
app.use("/api", geminiRoutes);
app.use("/api", creditCardRoutes);

// --- Automated Task Scheduler ---
cron.schedule("0 0 * * *", async () => {
  console.log("Running daily check for credit card bills due...");
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const billsToPay = await Expense.findAll({
      where: {
        is_paid: false,
        paid_with_credit_card: true,
        due_date: {
          [Op.lte]: today,
        },
      },
    });

    if (billsToPay.length > 0) {
      console.log(
        `Found ${billsToPay.length} credit card bills to mark as paid.`
      );
      for (const bill of billsToPay) {
        bill.is_paid = true;
        await bill.save();
        console.log(`Marked bill "${bill.name}" (ID: ${bill.id}) as paid.`);
      }
    } else {
      console.log("No credit card bills due today.");
    }
  } catch (error) {
    console.error("Error in scheduled task:", error);
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
