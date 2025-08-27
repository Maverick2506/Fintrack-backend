const express = require("express");
const cors = require("cors");
const { sequelize } = require("./models");
const authRoutes = require("./routes/auth");
const expenseRoutes = require("./routes/expenses");
const debtRoutes = require("./routes/debts");
const savingsGoalRoutes = require("./routes/savingsGoals");
const dashboardRoutes = require("./routes/dashboard");
const geminiRoutes = require("./routes/gemini");

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
