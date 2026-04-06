const express = require("express");
const cors = require("cors");
const { sequelize, Expense, CreditCard } = require("./models");
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
app.use("/api", paychequeRoutes);

app.get("/api/daily-check", async (req, res) => {
  console.log("Running daily check for due credit card bills...");
  try {
    const TIMEZONE = "America/Toronto";
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    // Format perfectly to YYYY-MM-DD
    const todayString = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    const billsToUpdate = await Expense.findAll({
      where: {
        is_paid: false,
        paid_with_credit_card: true,
        due_date: {
          [Op.lte]: todayString,
        },
      },
    });

    if (billsToUpdate.length > 0) {
      console.log(
        `Found ${billsToUpdate.length} credit card bill(s) to officially mark as paid & apply to balances.`
      );
      for (const bill of billsToUpdate) {
        if (bill.creditCardId) {
           const card = await CreditCard.findByPk(bill.creditCardId);
           if (card) {
               card.currentBalance = parseFloat(card.currentBalance) + parseFloat(bill.amount);
               await card.save();
           }
        }
        bill.is_paid = true;
        await bill.save();
        console.log(`Marked bill "${bill.name}" (ID: ${bill.id}) as paid and added to card balance.`);
      }
    } else {
      console.log("No overdue credit card bills found today.");
    }
    res.status(200).send("Daily check complete.");
  } catch (error) {
    console.error("Error running the scheduled bill payment task:", error);
    res.status(500).send("Error in daily check.");
  }
});

// --- Automated Task Schedulers ---
// This job runs daily at midnight to mark due credit card bills as paid and apply their balances.
cron.schedule("0 0 * * *", async () => {
  console.log("Cron triggering daily check for due credit card bills...");
  try {
    // Simply fire the logic natively
    const TIMEZONE = "America/Toronto";
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    const todayString = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    const billsToUpdate = await Expense.findAll({
      where: {
        is_paid: false,
        paid_with_credit_card: true,
        due_date: {
          [Op.lte]: todayString,
        },
      },
    });

    if (billsToUpdate.length > 0) {
      for (const bill of billsToUpdate) {
        if (bill.creditCardId) {
           const card = await CreditCard.findByPk(bill.creditCardId);
           if (card) {
               card.currentBalance = parseFloat(card.currentBalance) + parseFloat(bill.amount);
               await card.save();
           }
        }
        bill.is_paid = true;
        await bill.save();
      }
    }
  } catch (error) {
    console.error("Error running the scheduled bill payment task:", error);
  }
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
