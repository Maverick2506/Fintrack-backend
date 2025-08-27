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
const {
  router: recurringRoutes,
  createRecurringExpenses,
} = require("./routes/recurring");

const app = express();

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
app.use("/api/auth", authRoutes);
app.use("/api", expenseRoutes);
app.use("/api", debtRoutes);
app.use("/api", savingsGoalRoutes);
app.use("/api", dashboardRoutes);
app.use("/api", geminiRoutes);
app.use("/api", creditCardRoutes);
app.use("/api/recurring", recurringRoutes);

// --- Automated Task Schedulers ---
// This job runs daily at midnight to mark due credit card bills as paid.
cron.schedule("0 0 * * *", async () => {
  console.log("Running daily check for due credit card bills...");
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const billsToUpdate = await Expense.findAll({
      where: {
        is_paid: false,
        paid_with_credit_card: true,
        due_date: {
          [Op.lte]: today,
        },
      },
    });

    if (billsToUpdate.length > 0) {
      console.log(
        `Found ${billsToUpdate.length} credit card bill(s) to mark as paid.`
      );
      for (const bill of billsToUpdate) {
        bill.is_paid = true;
        await bill.save();
        console.log(`Marked bill "${bill.name}" (ID: ${bill.id}) as paid.`);
      }
    } else {
      console.log("No overdue credit card bills found today.");
    }
  } catch (error) {
    console.error("Error running the scheduled bill payment task:", error);
  }
});

// This job runs at 1 AM on the first day of every month to create recurring expenses.
cron.schedule("0 1 1 * *", createRecurringExpenses);
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
