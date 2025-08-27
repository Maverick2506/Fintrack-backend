const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let genAI;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
} else {
  console.error("GEMINI_API_KEY is not set. AI features will be disabled.");
}

router.use(authMiddleware);

// MODIFIED: Updated the prompt to include credit card data
router.post("/financial-advice", async (req, res) => {
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });

    // Create a cleaner, more focused summary for the AI
    const financialData = req.body;
    const summaryForAI = {
      monthlySummary: financialData.monthlySummary,
      upcomingBills: financialData.upcomingBills.map((b) => ({
        name: b.name,
        amount: b.amount,
        due_date: b.due_date,
      })),
      debtSummary: financialData.debtSummary.map((d) => ({
        name: d.name,
        total_remaining: d.total_remaining,
        monthly_payment: d.monthly_payment,
      })),
      savingsSummary: financialData.savingsSummary.map((s) => ({
        name: s.name,
        current_amount: s.current_amount,
        goal_amount: s.goal_amount,
      })),
      // Add a clear summary of credit cards
      creditCardSummary: financialData.creditCardSummary.map((c) => ({
        name: c.name,
        currentBalance: c.currentBalance,
        creditLimit: c.creditLimit,
        dueDate: c.dueDate,
      })),
    };

    const prompt = `Based on the following financial data for a user named Maverick, provide a short, actionable financial tip. Focus on practical advice regarding their income, spending, upcoming bills, debts, savings, or credit card usage. Financial Data: ${JSON.stringify(
      summaryForAI
    )}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ advice: response.text() });
  } catch (error) {
    console.error("Gemini financial advice error:", error);
    res.status(500).json({ error: "Failed to generate financial advice." });
  }
});

// This route remains the same
router.post("/categorize-expense", async (req, res) => {
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });
    const prompt = `Categorize the following expense into one of these categories: Essentials, Subscription, Debt, Food & Drink, Transportation, Entertainment, Shopping, Other. Expense: "${req.body.name}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ category: response.text().trim() });
  } catch (error) {
    console.error("Gemini categorization error:", error);
    res.status(500).json({ error: "Failed to categorize expense." });
  }
});

module.exports = router;
