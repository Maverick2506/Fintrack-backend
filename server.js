const express = require("express");
const cors = require("cors");
const { sequelize, Expense } = require("./models"); // Import Expense model
const { Op } = require("sequelize"); // Import Op for queries
const cron = require("node-cron"); // Import the cron library
const authRoutes = require("./routes/auth");
const expenseRoutes = require("./routes/expenses");
const debtRoutes = require("./routes/debts");
const savingsGoalRoutes = require("./routes/savingsGoals");
const dashboardRoutes = require("./routes/dashboard");
const geminiRoutes = require("./routes/gemini");
const creditCardRoutes = require("./routes/creditCards");

const app = express();

// --- CORS CONFIGURATION ---
const corsOptions = {
  origin: "https://fintrack-frontend-jet.vercel.app", // Your frontend URL
  optionsSuccessStatus: 200,
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

// --- NEW: Automated Task Scheduler ---
// This will run every day at midnight.
cron.schedule("0 0 * * *", async () => {
  console.log("Running daily check for credit card bills due...");
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Set to the beginning of the day

    // Find all unpaid expenses that were paid with a credit card
    // and whose due date is today or in the past.
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
// --- END: Automated Task Scheduler ---

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
