const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Paycheque } = require("../models");
const { Op } = require("sequelize");
const { addDays, parseISO, isSameMonth, isAfter, format } = require("date-fns");
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

    const { monthlySummary, allUpcomingBills, debtSummary, creditCardSummary, savingsSummary } =
      req.body;

    // --- NEW: Add validation to ensure data exists before using it ---
    if (
      !monthlySummary ||
      !allUpcomingBills ||
      !debtSummary ||
      !creditCardSummary ||
      !savingsSummary
    ) {
      return res
        .status(400)
        .json({ error: "Incomplete financial data provided." });
    }

    // --- NEW: Mathematical Paycheque Projection Engine ---
    let projectedIncomeText = "No future income accurately projected for the rest of this month.";
    try {
      const recentPaycheques = await Paycheque.findAll({
        where: {
          name: {
            [Op.or]: [
              { [Op.like]: "%pay%" },
              { [Op.like]: "%paycheck%" },
              { [Op.like]: "%paycheque%" }
            ]
          }
        },
        order: [["payment_date", "DESC"]],
        limit: 3
      });

      if (recentPaycheques.length > 0) {
        // Calculate average amount
        const totalAmount = recentPaycheques.reduce((sum, p) => sum + parseFloat(p.amount), 0);
        const averageAmount = totalAmount / recentPaycheques.length; // Flawlessly handles length of 1
        
        let lastDate = parseISO(recentPaycheques[0].payment_date);
        const today = new Date();
        let nextDate = addDays(lastDate, 14);

        // Advance 14 days iteratively until the date is strictly in the future
        while (!isAfter(nextDate, today)) {
            nextDate = addDays(nextDate, 14);
        }

        // If the calculated next payday still falls within the CURRENT calendar month
        if (isSameMonth(nextDate, today)) {
          projectedIncomeText = `Expected Upcoming Income: $${averageAmount.toFixed(2)} arriving accurately on ${format(nextDate, "MMM do")}.`;
        }
      }
    } catch (err) {
      console.error("Failed to project income, continuing without it.", err);
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

      5.  **Projected Upcoming Inflow:**
          * ${projectedIncomeText}

      6.  **Active Savings Goals:**
          * ${
            savingsSummary.length > 0
              ? savingsSummary
                  .map(
                    (goal) =>
                      `${goal.name}: $${parseFloat(goal.current_amount).toFixed(2)} saved out of $${parseFloat(goal.goal_amount).toFixed(2)} goal.`
                  )
                  .join("\n          * ")
              : "No active savings goals."
          }

      Based on this complete picture, follow this STRICT Mathematical Cashflow Constraint before giving your single actionable advice:
      You must mentally calculate: (Current Net Cash Flow) + (Projected Upcoming Inflow) - (Upcoming Bills). 
      If that number is very negative, advise them to immediately scale back non-essentials.
      If that number is highly positive, advise them specifically on which exact "Active Savings Goal" or "Installment Debt" they should allocate their leftover surplus into!
      Keep the final response short and human-readable.
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
    
    const validCategories = ["Essentials", "Subscription", "Debt", "Food & Drink", "Transportation", "Entertainment", "Shopping", "Other"];
    
    const prompt = `Categorize the following expense into exactly one of these categories: ${validCategories.join(", ")}. 
    Return ONLY the exact category name and absolutely nothing else. Do not include any explanations, asterisks, or markdown formatting.
    Expense: "${req.body.name}"`;
    
    const result = await model.generateContent(prompt);
    let responseText = await result.response.text();
    
    // Sanitize the response (strip markdown like ** ** or \n)
    responseText = responseText.replace(/[*_`"'\n]/g, "").trim();
    
    // Fallback safety check: verify the response actually matches an ENUM
    let finalCategory = "Other"; 
    for (const cat of validCategories) {
      if (responseText.toLowerCase().includes(cat.toLowerCase())) {
        finalCategory = cat;
        break;
      }
    }
    
    res.json({ category: finalCategory });
  } catch (error) {
    console.error("Gemini categorization error:", error);
    res.status(500).json({ error: "Failed to categorize expense." });
  }
});

module.exports = router;
