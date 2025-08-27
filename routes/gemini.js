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

// MODIFIED: This route now uses a much more detailed prompt
router.post("/financial-advice", async (req, res) => {
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });

    // Destructure the detailed financial data from the request body
    const { monthlySummary, upcomingBills, debtSummary, creditCardSummary } =
      req.body;

    // Create a more comprehensive prompt for the AI
    const prompt = `
      As a financial advisor for a user named Maverick, provide a short, actionable financial tip based on the following data for the current month:

      1.  **Monthly Cash Flow:**
          * Total Income: $${monthlySummary.totalIncome.toFixed(2)}
          * Total Cash Spending (excluding credit card expenses): $${monthlySummary.totalSpending.toFixed(
            2
          )}
          * Net Cash Flow: $${monthlySummary.netFlow.toFixed(2)}

      2.  **Upcoming Bills for the Rest of the Month:**
          * You have the following unpaid bills due: ${upcomingBills
            .map((bill) => `${bill.name} ($${bill.amount}) on ${bill.due_date}`)
            .join(", ")}.

      3.  **Credit Card Balances:**
          * ${creditCardSummary
            .map(
              (card) =>
                `${card.name}: $${parseFloat(card.currentBalance).toFixed(
                  2
                )} balance on a $${parseFloat(card.creditLimit).toFixed(
                  2
                )} limit.`
            )
            .join("\n          * ")}

      4.  **Overall Debts:**
          * ${debtSummary
            .map(
              (debt) =>
                `${debt.name}: $${parseFloat(debt.total_remaining).toFixed(
                  2
                )} remaining.`
            )
            .join("\n          * ")}

      Based on this complete picture, what is one specific, actionable piece of advice you can give Maverick? (For example, suggest paying down a high-interest card, warn about an upcoming large expense, or praise a low spending amount).
    `;

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
