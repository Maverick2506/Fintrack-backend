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
    let totalProjectedAmount = 0;
    try {
      const recentPaycheques = await Paycheque.findAll({
        order: [["payment_date", "DESC"]],
        limit: 3
      });

      if (recentPaycheques.length > 0) {
        // Calculate average amount
        const totalAmount = recentPaycheques.reduce((sum, p) => sum + parseFloat(p.amount), 0);
        const averageAmount = totalAmount / recentPaycheques.length; // Flawlessly handles length of 1
        
        // Ensure parsing aligns flawlessly with local noon to prevent UTC shifting backwards a day
        let lastDate = new Date(`${recentPaycheques[0].payment_date}T12:00:00`);
        const today = new Date();
        let nextDate = addDays(lastDate, 14);

        let totalProjectedInLoop = 0;
        let upcomingDates = [];

        // Advance 14 days iteratively until the mathematical date is strictly in the future
        while (!isAfter(nextDate, today)) {
            nextDate = addDays(nextDate, 14);
        }

        // Keep accumulating explicitly for EVERY remaining pay schedule inside this calendar month
        while (isSameMonth(nextDate, today)) {
            upcomingDates.push(format(nextDate, "MMM do"));
            totalProjectedInLoop += averageAmount;
            nextDate = addDays(nextDate, 14);
        }

        if (upcomingDates.length > 0) {
          totalProjectedAmount = totalProjectedInLoop;
          projectedIncomeText = `Expected Upcoming Income: $${totalProjectedAmount.toFixed(2)} total, arriving across ${upcomingDates.length} upcoming paychecks (${upcomingDates.join(" and ")}).`;
        }
      }
    } catch (err) {
      console.error("Failed to project income, continuing without it.", err);
    }

    const upcomingBillsTotal = allUpcomingBills.reduce((sum, b) => sum + parseFloat(b.amount), 0);
    const finalProjectedCashflow = monthlySummary.netFlow + totalProjectedAmount - upcomingBillsTotal;

    // Create a more comprehensive prompt for the AI
    const prompt = `
      As a financial advisor for a user named Maverick, provide a short, actionable financial tip based on the following data for the current month.

      1.  **Current Cash Snapshot:**
          * Total Income Received: $${monthlySummary.totalIncome.toFixed(2)}
          * Total Past Spending: $${monthlySummary.totalSpending.toFixed(2)}
          * Current Live Net Cash Flow: $${monthlySummary.netFlow.toFixed(2)}

      2.  **Required Upcoming Bill Deductions:**
          * You have the following unpaid bills due: ${
            allUpcomingBills.length > 0
              ? allUpcomingBills.map((bill) => `${bill.name} ($${bill.amount}) on ${bill.due_date}`).join(", ")
              : "None"
          }.
          * Total Upcoming Bill Burden: $${upcomingBillsTotal.toFixed(2)}

      3.  **Projected Upcoming Paycheques (Rest of Month):**
          * ${projectedIncomeText}

      4.  **Mathematically Verified End-of-Month Float:**
          * Guaranteed Remaining Cash (Net Flow + Projected Income - Upcoming Bills): $${finalProjectedCashflow.toFixed(2)}

      5.  **Active Savings Goals:**
          * ${
            savingsSummary.length > 0
              ? savingsSummary.map((goal) => `${goal.name}: $${parseFloat(goal.current_amount).toFixed(2)} saved out of $${parseFloat(goal.goal_amount).toFixed(2)} goal.`).join("\n          * ")
              : "No active savings goals."
          }

      Based on this absolute picture: 
      The most important number is the **End-of-Month Float** ($${finalProjectedCashflow.toFixed(2)}). 
      If it is negative, tell them immediately to stop non-essential spending.
      If it is highly positive, advise them specifically on which exact "Active Savings Goal" they should allocate their leftover surplus into!
      Keep the final response short and human-readable, and specifically call out the End-of-Month float number.
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
