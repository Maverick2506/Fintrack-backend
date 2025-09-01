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

// MODIFIED: This route now has robust checks to prevent crashes
router.post("/financial-advice", async (req, res) => {
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // Log the incoming data to help with debugging
    console.log(
      "Received data for financial advice:",
      JSON.stringify(req.body, null, 2)
    );

    const { monthlySummary, allUpcomingBills, debtSummary, creditCardSummary } =
      req.body;

    // --- NEW: Add validation to ensure data exists before using it ---
    if (
      !monthlySummary ||
      !allUpcomingBills ||
      !debtSummary ||
      !creditCardSummary
    ) {
      return res
        .status(400)
        .json({ error: "Incomplete financial data provided." });
    }

    // Create a more comprehensive prompt for the AI
    const prompt = `
      As a financial advisor for a user named Maverick, provide a short, actionable financial tip based on the following data for the current month so far. This is a snapshot and not the final monthly numbers.:

      1.  **Monthly Cash Flow:**
          * Total Income: $${monthlySummary.totalIncome.toFixed(2)}
          * Total Cash Spending (not including new credit card debt): $${monthlySummary.totalSpending.toFixed(
            2
          )}
          * Net Cash Flow: $${monthlySummary.netFlow.toFixed(2)}

      2.  **All Upcoming Bills for This Month:**
          * You have the following unpaid bills due: ${
            allUpcomingBills.length > 0
              ? allUpcomingBills
                  .map(
                    (bill) =>
                      `${bill.name} ($${bill.amount}) on ${bill.due_date}`
                  )
                  .join(", ")
              : "None"
          }.

      3.  **Credit Card Balances:**
          * ${
            creditCardSummary.length > 0
              ? creditCardSummary
                  .map(
                    (card) =>
                      `${card.name}: $${parseFloat(card.currentBalance).toFixed(
                        2
                      )} balance on a $${parseFloat(card.creditLimit).toFixed(
                        2
                      )} limit.`
                  )
                  .join("\n          * ")
              : "No credit cards."
          }

      4.  **Overall Installment Debts:**
          * ${
            debtSummary.length > 0
              ? debtSummary
                  .map(
                    (debt) =>
                      `${debt.name}: $${parseFloat(
                        debt.total_remaining
                      ).toFixed(2)} remaining.`
                  )
                  .join("\n          * ")
              : "No installment debts."
          }

      Based on this complete picture, what is one specific, actionable piece of advice you can give Maverick? Focus on the most immediate and impactful action they can take.
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
      model: "gemini-2.5-flash",
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
