const express = require("express");
const { getBalancesSummary } = require("../services/netWorthService");
const { GoogleGenAI } = require("@google/genai");
const { sequelize, Transaction, Account } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { getPaychequeProjection } = require("../services/projectionService");
const { getCalculatedCheckingBalance } = require("../services/checkingService");
const router = express.Router();

const TIMEZONE = "America/Toronto";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";

let ai;
if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
} else {
  console.error("GEMINI_API_KEY is not set. AI features will be disabled.");
}

router.use(authMiddleware);

// --- 1. STRUCTURED FINANCIAL ADVICE ---
router.post("/financial-advice", async (req, res) => {
  if (!ai) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const {
      monthlySummary,
      allUpcomingBills,
      debtSummary,
      creditCardSummary,
      savingsSummary,
    } = req.body;

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

    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
    const currentMonthPrefix = todayStr.slice(0, 7);

    // Dynamic Mathematical Paycheque Projection Engine
    let projectedIncomeText =
      "No future income accurately projected for the rest of this month.";
    let totalProjectedAmount = 0;
    try {
      const projection = await getPaychequeProjection(todayStr, currentMonthPrefix);
      if (projection.projectedPaychequeDates.length > 0) {
        totalProjectedAmount = projection.totalProjectedIncome;
        projectedIncomeText = `Expected Upcoming Income: $${totalProjectedAmount.toFixed(
          2
        )} total, arriving across ${
          projection.projectedPaychequeDates.length
        } upcoming paycheque(s) (${projection.projectedPaychequeDates.join(", ")}).`;
      }
    } catch (err) {
      console.error("Failed to project income, continuing without it.", err);
    }

    const balancesSummary = await getBalancesSummary(null, todayStr);
    const upcomingBillsTotal = allUpcomingBills.reduce(
      (sum, b) => sum + parseFloat(b.amount),
      0
    );
    const finalProjectedCashflow =
      monthlySummary.netFlow + totalProjectedAmount - upcomingBillsTotal;

    const prompt = `
You are a premier personal financial strategist for Maverick.
Analyze this financial snapshot for the current month:

1. Current Cash Snapshot:
- Total Net Worth: ${balancesSummary.netWorth.toFixed(2)} (Checking: ${balancesSummary.checking.toFixed(2)}, Savings: ${balancesSummary.savings.toFixed(2)}, Debt: ${balancesSummary.debt.toFixed(2)}, Cards: ${balancesSummary.cards.toFixed(2)})
- Total Income Received So Far: $${monthlySummary.totalIncome.toFixed(2)}
- Total Spending So Far: $${monthlySummary.totalSpending.toFixed(2)}
- Current Live Net Cash Flow: $${monthlySummary.netFlow.toFixed(2)}

2. Upcoming Bills Due Before Month End:
${
  allUpcomingBills.length > 0
    ? allUpcomingBills
        .map(
          (b) =>
            `- ${b.title || b.name}: $${parseFloat(b.amount).toFixed(2)} on ${
              b.date || b.due_date
            }`
        )
        .join("\n")
    : "- None"
}
- Total Upcoming Bill Burden: $${upcomingBillsTotal.toFixed(2)}

3. Projected Upcoming Income:
- ${projectedIncomeText}

4. Mathematically Verified End-of-Month Float:
- Guaranteed Remaining Cash (Net Flow + Projected Income - Upcoming Bills): $${finalProjectedCashflow.toFixed(
      2
    )}

5. Debts & Credit Cards:
${
  debtSummary.length > 0
    ? debtSummary
        .map(
          (d) =>
            `- Debt: ${d.name}, Balance: $${parseFloat(
              d.initialBalance || 0
            ).toFixed(2)}, Min Pay: $${parseFloat(
              d.minimumPayment || 0
            ).toFixed(2)}`
        )
        .join("\n")
    : "- No debts."
}
${
  creditCardSummary.length > 0
    ? creditCardSummary
        .map(
          (c) =>
            `- Credit Card: ${c.name}, Balance: $${parseFloat(
              c.currentBalance || c.initialBalance || 0
            ).toFixed(2)}, Limit: $${parseFloat(c.creditLimit || 0).toFixed(2)}`
        )
        .join("\n")
    : "- No credit cards."
}

6. Active Savings Goals:
${
  savingsSummary.length > 0
    ? savingsSummary
        .map(
          (g) =>
            `- Goal: ${g.name}, Saved: $${parseFloat(
              g.initialBalance || g.current_amount || 0
            ).toFixed(2)} / Target: $${parseFloat(
              g.targetAmount || g.goal_amount || 0
            ).toFixed(2)}`
        )
        .join("\n")
    : "- No active goals."
}

CRITICAL INSTRUCTIONS:
Respond with ONLY a valid raw JSON object (no markdown code blocks, no backticks, no extra text) matching this schema:
{
  "healthStatus": "${
    finalProjectedCashflow < 0
      ? "warning"
      : finalProjectedCashflow < 200
      ? "caution"
      : "healthy"
  }",
  "headline": "Short punchy status (e.g., Safe Float: +$450 projected or Tight Margin ahead)",
  "floatAmount": ${finalProjectedCashflow.toFixed(2)},
  "summary": "2-3 concise, encouraging sentences directly addressing Maverick.",
  "tacticalActions": [
    "Specific action #1 with exact dollar amounts or accounts",
    "Specific action #2"
  ],
  "spendingAlert": "1-sentence note on an area to monitor (or null if all balanced)"
}
`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });

    const rawText = (response.text || "").trim();
    let structured = null;

    try {
      const cleanJson = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/, "")
        .replace(/\s*```$/, "")
        .trim();
      structured = JSON.parse(cleanJson);
    } catch {
      structured = {
        healthStatus:
          finalProjectedCashflow < 0
            ? "warning"
            : finalProjectedCashflow < 200
            ? "caution"
            : "healthy",
        headline: `End-of-Month Float: $${finalProjectedCashflow.toFixed(2)}`,
        floatAmount: finalProjectedCashflow,
        summary: rawText,
        tacticalActions: [
          finalProjectedCashflow < 0
            ? "Pause discretionary spending to protect upcoming bills."
            : "Allocate leftover float towards high-priority debt or emergency fund.",
        ],
        spendingAlert: null,
      };
    }

    res.json({
      advice: structured.summary || rawText,
      structured,
    });
  } catch (error) {
    console.error("Gemini financial advice error:", error);
    res.status(500).json({ error: "Failed to generate financial advice." });
  }
});

// --- 2. SMART AUTO-CATEGORIZATION (History First + Gemini Fallback) ---
router.post("/categorize-expense", async (req, res) => {
  const expenseName = (req.body.name || "").trim();
  if (!expenseName) {
    return res.json({ category: "Other", source: "default" });
  }

  try {
    // 1. Check user's own past transaction history (0ms latency, zero API cost, 100% personalized)
    const pastTx = await Transaction.findOne({
      where: sequelize.where(
        sequelize.fn("LOWER", sequelize.col("title")),
        expenseName.toLowerCase()
      ),
      order: [["createdAt", "DESC"]],
    });

    if (pastTx && pastTx.category && pastTx.category !== "Other") {
      return res.json({ category: pastTx.category, source: "history" });
    }

    if (!ai) {
      return res.json({ category: "Other", source: "default" });
    }

    const validCategories = [
      "Essentials",
      "Subscription",
      "Debt",
      "Food & Drink",
      "Transportation",
      "Entertainment",
      "Shopping",
      "Other",
    ];

    const prompt = `Categorize the following expense into exactly one of these categories: ${validCategories.join(
      ", "
    )}.
Return ONLY the exact category name and absolutely nothing else.
Expense: "${expenseName}"`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });
    const responseText = (response.text || "").replace(/[*_`"'\n]/g, "").trim();

    let finalCategory = "Other";
    for (const cat of validCategories) {
      if (responseText.toLowerCase().includes(cat.toLowerCase())) {
        finalCategory = cat;
        break;
      }
    }

    res.json({ category: finalCategory, source: "ai" });
  } catch (error) {
    console.error("Gemini categorization error:", error);
    res.json({ category: "Other", source: "fallback" });
  }
});

// --- 3. INTERACTIVE FINANCIAL CHAT ASSISTANT ("Chat with your Money") ---
router.post("/chat-advisor", async (req, res) => {
  if (!ai) {
    return res.status(500).json({ error: "AI service is not configured." });
  }

  const userMessage = (req.body.message || "").trim();
  if (!userMessage) {
    return res.status(400).json({ error: "Message is required." });
  }

  const conversationHistory = Array.isArray(req.body.history)
    ? req.body.history
    : [];

  try {
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
    const currentMonthPrefix = todayStr.slice(0, 7);

    const [year, month] = todayStr.split("-").map(Number);
    const startOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endOfMonth = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    // Fetch comprehensive live financial reality
    const [
      accounts,
      recentTransactions,
      monthExpenses,
      monthIncome,
      upcomingBills,
    ] = await Promise.all([
      Account.findAll({ order: [["type", "ASC"], ["name", "ASC"]] }),
      Transaction.findAll({
        order: [
          ["date", "DESC"],
          ["createdAt", "DESC"],
        ],
        limit: 30,
      }),
      Transaction.sum("amount", {
        where: {
          type: "EXPENSE",
          isCleared: true,
          date: { [Op.between]: [startOfMonth, endOfMonth] },
        },
      }),
      Transaction.sum("amount", {
        where: {
          type: "INCOME",
          isCleared: true,
          date: { [Op.between]: [startOfMonth, endOfMonth] },
        },
      }),
      Transaction.findAll({
        where: {
          type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
          isCleared: false,
          date: { [Op.gte]: todayStr },
        },
        order: [["date", "ASC"]],
        limit: 10,
      }),
    ]);

    const checking = accounts.find((a) => a.type === "CHECKING");
    const checkingBalance = checking
      ? await getCalculatedCheckingBalance(checking, todayStr)
      : 0;
    const cards = accounts.filter((a) => a.type === "CREDIT_CARD");
    const debts = accounts.filter((a) => a.type === "DEBT");
    const goals = accounts.filter((a) => a.type === "SAVINGS_GOAL");

    const systemPrompt = `
You are Maverick's elite personal financial advisor and money strategist inside the FinTrack application.
Today's date is ${todayStr}.

LIVE FINANCIAL REALITY FOR MAVERICK:
- Checking Account: ${
      checking
        ? `${checking.name} (Current Balance: $${checkingBalance.toFixed(2)})`
        : "Primary Checking ($0.00)"
    }
- Current Month Cash Flow: Total Cleared Income: $${(
      parseFloat(monthIncome) || 0
    ).toFixed(2)} | Total Cleared Spending: $${(
      parseFloat(monthExpenses) || 0
    ).toFixed(2)} | Net Cash Flow: $${(
      (parseFloat(monthIncome) || 0) - (parseFloat(monthExpenses) || 0)
    ).toFixed(2)}
- Credit Cards:
${
  cards
    .map(
      (c) =>
        `  * ${c.name}: Balance $${parseFloat(c.initialBalance || 0).toFixed(
          2
        )} / Limit $${parseFloat(c.creditLimit || 0).toFixed(2)}`
    )
    .join("\n") || "  None"
}
- Debts:
${
  debts
    .map(
      (d) =>
        `  * ${d.name}: Balance $${parseFloat(d.initialBalance || 0).toFixed(
          2
        )}, Min Pay $${parseFloat(d.minimumPayment || 0).toFixed(
          2
        )}, Interest: ${d.interestRate ? `${d.interestRate}%` : "N/A"}`
    )
    .join("\n") || "  None"
}
- Savings Goals:
${
  goals
    .map(
      (g) =>
        `  * ${g.name}: $${parseFloat(g.initialBalance || 0).toFixed(
          2
        )} saved / Target $${parseFloat(g.targetAmount || 0).toFixed(2)}`
    )
    .join("\n") || "  None"
}
- Upcoming Unpaid Bills:
${
  upcomingBills
    .map(
      (b) =>
        `  * ${b.title}: $${parseFloat(b.amount).toFixed(2)} due on ${b.date}`
    )
    .join("\n") || "  None"
}
- Recent Transactions (Past 30):
${recentTransactions
  .map(
    (t) =>
      `  * ${t.date} | ${t.type} | ${t.title} | $${parseFloat(t.amount).toFixed(
        2
      )} | Category: ${t.category} | Cleared: ${t.isCleared}`
  )
  .join("\n")}

BEHAVIOR GUIDELINES:
1. Address Maverick personally, warmly, and directly.
2. Be mathematically precise, concise, and pragmatic.
3. If Maverick asks "Can I afford X?", calculate the impact on their checking balance, upcoming bills, and remaining float. Provide a direct, actionable answer.
4. Format responses using clean GitHub markdown (bold key amounts, use concise bullet points).
5. Never output generic boilerplate or disclaimers; speak as a trusted, highly capable personal financial co-pilot.
`;

    const contents = [
      {
        role: "user",
        parts: [
          { text: systemPrompt + "\n\nPlease confirm you understand your role." },
        ],
      },
      {
        role: "model",
        parts: [
          {
            text: "Understood! I'm ready with Maverick's complete financial snapshot. How can I help you optimize your money today?",
          },
        ],
      },
    ];

    for (const msg of conversationHistory.slice(-8)) {
      if (msg.role === "user" || msg.role === "model") {
        contents.push({
          role: msg.role,
          parts: [{ text: msg.text || msg.content || "" }],
        });
      }
    }

    contents.push({
      role: "user",
      parts: [{ text: userMessage }],
    });

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
    });

    res.json({ reply: response.text || "" });
  } catch (error) {
    console.error("Gemini chat advisor error:", error);
    res
      .status(500)
      .json({ error: "Failed to generate response from AI advisor." });
  }
});

module.exports = router;

