const express = require("express");
const cors = require("cors");
const compression = require("compression");
const { sequelize, Expense, CreditCard, Debt } = require("./models");
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

    // 1. Process Due Credit Cards
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
      console.log(`Found ${billsToUpdate.length} credit card bill(s) to officially mark as paid & apply to balances.`);
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
    } else {
      console.log("No overdue credit card bills found today.");
    }

    // 2. Process Auto-Pay Debts
    const debtsToUpdate = await Debt.findAll({
      where: {
        auto_pay: true,
        next_due_date: { [Op.lte]: todayString },
        total_remaining: { [Op.gt]: 0 },
      },
    });

    if (debtsToUpdate.length > 0) {
      console.log(`Found ${debtsToUpdate.length} auto-pay debt(s) maturity hits.`);
      for (const debt of debtsToUpdate) {
        const paymentAmount = Math.min(parseFloat(debt.monthly_payment), parseFloat(debt.total_remaining));
        
        // Subtract balance safely
        debt.total_remaining = parseFloat(debt.total_remaining) - paymentAmount;

        // Automatically create the Cash-Flow expense
        await Expense.create({
          name: `Auto-Payment for ${debt.name}`,
          amount: paymentAmount,
          due_date: todayString,
          is_paid: true,
          category: "Debt",
        });

        // Advance or Terminate
        if (debt.total_remaining > 0) {
           let currentDue = toZonedTime(`${debt.next_due_date}T00:00:00`, TIMEZONE);
           let nextDue;
           if (debt.payment_frequency === "weekly") nextDue = addDays(currentDue, 7);
           else if (debt.payment_frequency === "bi-weekly") nextDue = addDays(currentDue, 14);
           else if (debt.payment_frequency === "yearly") nextDue = addYears(currentDue, 1);
           else nextDue = addMonths(currentDue, 1);
           
           debt.next_due_date = format(nextDue, "yyyy-MM-dd", { timeZone: TIMEZONE });
        } else {
           debt.auto_pay = false; 
           debt.next_due_date = null;
        }

        await debt.save();
      }
    } else {
      console.log("No mature auto-pay debts found today.");
    }
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
