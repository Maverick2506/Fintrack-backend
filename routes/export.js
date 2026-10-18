const express = require("express");
const crypto = require("crypto");
const { toZonedTime, format } = require("date-fns-tz");
const { Op } = require("sequelize");
const { sequelize, Account, Transaction, Setting } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { getNextOccurrenceDate } = require("./recurring");

const router = express.Router();
const TIMEZONE = "America/Toronto";
const SETTING_KEY = "gemini_feed_token";

// Helper: Retrieve or initialize persistent secret feed token
const getOrCreateFeedToken = async () => {
  let record = await Setting.findByPk(SETTING_KEY);
  if (!record || !record.value) {
    const newToken = `ft_live_${crypto.randomBytes(16).toString("hex")}`;
    if (record) {
      record.value = newToken;
      await record.save();
    } else {
      record = await Setting.create({ key: SETTING_KEY, value: newToken });
    }
  }
  return record.value;
};

// Helper: Regenerate feed token
const regenerateFeedToken = async () => {
  const newToken = `ft_live_${crypto.randomBytes(16).toString("hex")}`;
  const [record] = await Setting.findOrCreate({
    where: { key: SETTING_KEY },
    defaults: { value: newToken },
  });
  record.value = newToken;
  await record.save();
  return record.value;
};

// Helper: Fetch live financial snapshot
const getFinancialData = async () => {
  const nowZoned = toZonedTime(new Date(), TIMEZONE);
  const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
  const [year, month] = todayStr.split("-").map(Number);
  const startOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endOfMonth = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const currentMonthPrefix = todayStr.slice(0, 7);

  const [accounts, monthExpensesSum, monthIncomeSum, upcomingBills, recentTransactions] =
    await Promise.all([
      Account.findAll({ order: [["type", "ASC"], ["name", "ASC"]] }),
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
          type: "EXPENSE",
          isCleared: false,
          date: { [Op.gte]: todayStr },
        },
        order: [["date", "ASC"]],
        include: [
          { model: Account, as: "fromAccount" },
          { model: Account, as: "toAccount" },
        ],
        limit: 20,
      }),
      Transaction.findAll({
        order: [
          ["date", "DESC"],
          ["createdAt", "DESC"],
        ],
        limit: 50,
      }),
    ]);

  const checkingAcc = accounts.find((a) => a.type === "CHECKING");
  let checkingBalance = parseFloat(checkingAcc?.initialBalance || 0);
  if (checkingAcc) {
    const [
      allTimeIncome,
      allTimeCheckingExp,
      allTimeTransfersOut,
      allTimeTransfersIn,
    ] = await Promise.all([
      Transaction.sum("amount", {
        where: {
          type: "INCOME",
          isCleared: true,
          date: { [Op.lte]: todayStr },
          [Op.or]: [{ toAccountId: checkingAcc.id }, { toAccountId: null }],
        },
      }),
      Transaction.sum("amount", {
        where: {
          type: "EXPENSE",
          isCleared: true,
          fromAccountId: checkingAcc.id,
        },
      }),
      Transaction.sum("amount", {
        where: { type: "TRANSFER", fromAccountId: checkingAcc.id },
      }),
      Transaction.sum("amount", {
        where: { type: "TRANSFER", toAccountId: checkingAcc.id },
      }),
    ]);
    const netCheckingActivity =
      (parseFloat(allTimeIncome) || 0) -
      (parseFloat(allTimeCheckingExp) || 0) -
      (parseFloat(allTimeTransfersOut) || 0) +
      (parseFloat(allTimeTransfersIn) || 0);
    checkingBalance =
      Math.round((checkingBalance + netCheckingActivity) * 100) / 100;
  }

  const creditCards = accounts.filter((a) => a.type === "CREDIT_CARD");
  const debts = accounts.filter((a) => a.type === "DEBT");
  const savingsGoals = accounts.filter((a) => a.type === "SAVINGS_GOAL");

  const totalCC = creditCards.reduce((s, c) => s + parseFloat(c.initialBalance || 0), 0);
  const totalDebt = debts.reduce((s, d) => s + parseFloat(d.initialBalance || 0), 0);
  const totalSavings = savingsGoals.reduce((s, g) => s + parseFloat(g.initialBalance || 0), 0);

  const netWorth = checkingBalance + totalSavings - totalDebt - totalCC;
  const clearedIncome = parseFloat(monthIncomeSum || 0);
  const clearedExpenses = parseFloat(monthExpensesSum || 0);
  const netFlow = clearedIncome - clearedExpenses;

  // Paycheque projection for remaining month
  let totalProjectedIncome = 0;
  let projectedPaychequeDates = [];
  try {
    const recentPaycheques = await Transaction.findAll({
      where: { type: "INCOME" },
      order: [["date", "DESC"]],
      limit: 5,
    });

    if (recentPaycheques.length > 0) {
      const avgAmt =
        recentPaycheques.reduce((sum, p) => sum + parseFloat(p.amount), 0) /
        recentPaycheques.length;

      let cadence = "bi-weekly";
      if (
        recentPaycheques[0].recurrence &&
        ["weekly", "bi-weekly", "monthly"].includes(recentPaycheques[0].recurrence)
      ) {
        cadence = recentPaycheques[0].recurrence;
      } else if (recentPaycheques.length >= 2) {
        const [y1, m1, d1] = recentPaycheques[0].date.split("-").map(Number);
        const [y2, m2, d2] = recentPaycheques[1].date.split("-").map(Number);
        const diffDays = Math.round(
          Math.abs(Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) /
            (1000 * 60 * 60 * 24)
        );
        if (diffDays >= 6 && diffDays <= 8) cadence = "weekly";
        else if (diffDays >= 12 && diffDays <= 17) cadence = "bi-weekly";
        else if (diffDays >= 27) cadence = "monthly";
      }

      let step = 1;
      while (step <= 10) {
        const nextDateStr = getNextOccurrenceDate(recentPaycheques[0].date, cadence, step);
        if (!nextDateStr) break;
        if (nextDateStr.startsWith(currentMonthPrefix)) {
          if (nextDateStr > todayStr) {
            projectedPaychequeDates.push(nextDateStr);
            totalProjectedIncome += avgAmt;
          }
        } else if (nextDateStr > todayStr) {
          break;
        }
        step++;
      }
    }
  } catch (err) {
    console.error("Paycheque projection error in export:", err);
  }

  const upcomingBillsFromChecking = upcomingBills.filter(
    (b) => !b.fromAccount || b.fromAccount.type === "CHECKING"
  );
  const upcomingBillsFromCC = upcomingBills.filter(
    (b) => b.fromAccount && b.fromAccount.type === "CREDIT_CARD"
  );

  const upcomingBillsTotal = upcomingBills.reduce(
    (s, b) => s + parseFloat(b.amount || 0),
    0
  );
  const upcomingCheckingBillsTotal = upcomingBillsFromChecking.reduce(
    (s, b) => s + parseFloat(b.amount || 0),
    0
  );
  const upcomingCCBillsTotal = upcomingBillsFromCC.reduce(
    (s, b) => s + parseFloat(b.amount || 0),
    0
  );

  // Cash float remaining in checking:
  // Checking balance + expected income - bills that are actually paid from checking
  const endOfMonthFloat =
    checkingBalance + totalProjectedIncome - upcomingCheckingBillsTotal;

  return {
    todayStr,
    checkingBalance,
    totalCC,
    totalDebt,
    totalSavings,
    netWorth,
    clearedIncome,
    clearedExpenses,
    netFlow,
    totalProjectedIncome,
    projectedPaychequeDates,
    upcomingBillsTotal,
    upcomingCheckingBillsTotal,
    upcomingCCBillsTotal,
    endOfMonthFloat,
    checkingAcc,
    creditCards,
    debts,
    savingsGoals,
    upcomingBills,
    recentTransactions,
  };
};

// Helper: Escape CSV fields safely
const csvEscape = (val) => {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// Helper: Generate structured CSV
const generateCSV = (d) => {
  const rows = [];

  // 1. OVERVIEW
  rows.push(["SECTION", "CATEGORY", "METRIC", "VALUE", "NOTES"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Snapshot", "Snapshot Date", d.todayStr, "Timezone: America/Toronto"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Accounts", "Primary Checking Balance", `$${d.checkingBalance.toFixed(2)}`, "Available liquid cash"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Accounts", "Estimated Net Worth", `$${d.netWorth.toFixed(2)}`, "Checking + Savings - Debts - Cards"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Cash Flow", "Month Cleared Income", `$${d.clearedIncome.toFixed(2)}`, "Total deposits cleared this month"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Cash Flow", "Month Cleared Spending", `$${d.clearedExpenses.toFixed(2)}`, "Total paid spending this month"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Cash Flow", "Current Net Cash Flow", `$${d.netFlow.toFixed(2)}`, "Cleared Income minus Cleared Spending"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Projected Upcoming Income", `$${d.totalProjectedIncome.toFixed(2)}`, `Expected on: ${d.projectedPaychequeDates.join("; ") || "None"}`].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Upcoming Unpaid Bills Total", `$${d.upcomingBillsTotal.toFixed(2)}`, "All unpaid bills remaining this month"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Upcoming Bills (From Checking)", `$${d.upcomingCheckingBillsTotal.toFixed(2)}`, "Bills directly deducting liquid cash from Primary Checking"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Upcoming Bills (On Credit Cards)", `$${d.upcomingCCBillsTotal.toFixed(2)}`, "Bills charged to credit cards (adds to card balance)"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Projected End-of-Month Float", `$${d.endOfMonthFloat.toFixed(2)}`, "Liquid cash remaining after checking bills & projected income"].map(csvEscape).join(","));

  // 2. ACCOUNTS & LIABILITIES
  rows.push([]);
  rows.push(["SECTION", "TYPE", "ACCOUNT_NAME", "CURRENT_BALANCE", "LIMIT_OR_TARGET", "INTEREST_RATE_PCT", "MIN_PAYMENT"].map(csvEscape).join(","));
  if (d.checkingAcc) {
    rows.push(["ACCOUNTS", "CHECKING", d.checkingAcc.name, d.checkingBalance.toFixed(2), "", "", ""].map(csvEscape).join(","));
  }
  for (const c of d.creditCards) {
    rows.push(["ACCOUNTS", "CREDIT_CARD", c.name, parseFloat(c.initialBalance || 0).toFixed(2), parseFloat(c.creditLimit || 0).toFixed(2), c.interestRate ? `${c.interestRate}%` : "", c.minimumPayment ? parseFloat(c.minimumPayment).toFixed(2) : ""].map(csvEscape).join(","));
  }
  for (const debt of d.debts) {
    rows.push(["ACCOUNTS", "DEBT", debt.name, parseFloat(debt.initialBalance || 0).toFixed(2), "", debt.interestRate ? `${debt.interestRate}%` : "", debt.minimumPayment ? parseFloat(debt.minimumPayment).toFixed(2) : ""].map(csvEscape).join(","));
  }
  for (const g of d.savingsGoals) {
    rows.push(["ACCOUNTS", "SAVINGS_GOAL", g.name, parseFloat(g.initialBalance || 0).toFixed(2), parseFloat(g.targetAmount || 0).toFixed(2), "", ""].map(csvEscape).join(","));
  }

  // 3. UPCOMING UNPAID BILLS
  rows.push([]);
  rows.push(["SECTION", "DUE_DATE", "BILL_TITLE", "AMOUNT", "DEDUCTED_FROM", "ACCOUNT_TYPE", "RECURRENCE", "TAX_STATUS"].map(csvEscape).join(","));
  for (const b of d.upcomingBills) {
    const isCC = b.fromAccount && b.fromAccount.type === "CREDIT_CARD";
    const sourceName = b.fromAccount ? b.fromAccount.name : "Primary Checking";
    const sourceType = isCC ? "CREDIT_CARD" : "CHECKING";
    rows.push([
      "UPCOMING_BILLS",
      b.date,
      b.title,
      parseFloat(b.amount).toFixed(2),
      sourceName,
      sourceType,
      b.recurrence || "one-time",
      b.isTaxExclusive ? "Tax Exclusive (Tax applied on due date)" : "Tax Included",
    ].map(csvEscape).join(","));
  }

  // 4. RECENT TRANSACTIONS
  rows.push([]);
  rows.push(["SECTION", "DATE", "TYPE", "CATEGORY", "TITLE", "AMOUNT", "CLEARED"].map(csvEscape).join(","));
  for (const t of d.recentTransactions) {
    rows.push(["RECENT_TRANSACTIONS", t.date, t.type, t.category, t.title, parseFloat(t.amount).toFixed(2), t.isCleared ? "YES" : "NO"].map(csvEscape).join(","));
  }

  return rows.join("\n");
};

// Helper: Generate structured Markdown
const generateMarkdown = (d) => {
  return `# FINTRACK FINANCIAL SNAPSHOT
**Generated:** ${d.todayStr} (America/Toronto)
**Owner:** Maverick

---

## 1. Executive Summary & Float
- **Primary Checking Balance:** $${d.checkingBalance.toFixed(2)}
- **Estimated Net Worth:** $${d.netWorth.toFixed(2)}
- **Current Month Cleared Income:** $${d.clearedIncome.toFixed(2)}
- **Current Month Cleared Spending:** $${d.clearedExpenses.toFixed(2)}
- **Current Net Cash Flow:** $${d.netFlow.toFixed(2)}
- **Projected Upcoming Income:** $${d.totalProjectedIncome.toFixed(2)} (${d.projectedPaychequeDates.length} upcoming paycheques)
- **Upcoming Unpaid Bills Total:** $${d.upcomingBillsTotal.toFixed(2)}
- **Projected End-of-Month Safe Float:** **$${d.endOfMonthFloat.toFixed(2)}**

---

## 2. Accounts & Liabilities

### Credit Cards
${
  d.creditCards.length === 0
    ? "_No active credit cards._"
    : d.creditCards
        .map(
          (c) =>
            `- **${c.name}:** Balance $${parseFloat(c.initialBalance || 0).toFixed(
              2
            )} / Limit $${parseFloat(c.creditLimit || 0).toFixed(2)} ${
              c.interestRate ? `(APR: ${c.interestRate}%)` : ""
            }`
        )
        .join("\n")
}

### Debts
${
  d.debts.length === 0
    ? "_No outstanding debts._"
    : d.debts
        .map(
          (debt) =>
            `- **${debt.name}:** Balance $${parseFloat(
              debt.initialBalance || 0
            ).toFixed(2)} | Min Payment: $${parseFloat(
              debt.minimumPayment || 0
            ).toFixed(2)} ${debt.interestRate ? `(Interest: ${debt.interestRate}%)` : ""}`
        )
        .join("\n")
}

### Savings Goals
${
  d.savingsGoals.length === 0
    ? "_No active savings goals._"
    : d.savingsGoals
        .map(
          (g) =>
            `- **${g.name}:** Saved $${parseFloat(g.initialBalance || 0).toFixed(
              2
            )} of $${parseFloat(g.targetAmount || 0).toFixed(2)} target`
        )
        .join("\n")
}

---

## 3. Upcoming Unpaid Bills
- **Total Upcoming Bills:** $${d.upcomingBillsTotal.toFixed(2)}
  - Deducted from Primary Checking: $${d.upcomingCheckingBillsTotal.toFixed(2)}
  - Charged to Credit Cards: $${d.upcomingCCBillsTotal.toFixed(2)}

${
  d.upcomingBills.length === 0
    ? "_No upcoming unpaid bills for the rest of this month._"
    : d.upcomingBills
        .map((b) => {
          const isCC = b.fromAccount && b.fromAccount.type === "CREDIT_CARD";
          const sourceName = b.fromAccount ? b.fromAccount.name : "Primary Checking";
          return `- **${b.date}:** ${b.title} — $${parseFloat(b.amount).toFixed(
            2
          )} (${b.recurrence || "one-time"}) — *Deducted from: ${
            isCC ? `Credit Card (${sourceName})` : `Checking (${sourceName})`
          }*`;
        })
        .join("\n")
}

---

## 4. Recent Transactions Ledger (Last 50)
| Date | Type | Category | Description | Amount |
| :--- | :--- | :--- | :--- | :--- |
${d.recentTransactions
  .map(
    (t) =>
      `| ${t.date} | ${t.type} | ${t.category} | ${t.title.replace(/\|/g, "/")} | $${parseFloat(
        t.amount
      ).toFixed(2)} |`
  )
  .join("\n")}
`;
};

// Helper: Generate specialized Gem instructions
const generateGemInstructions = () => {
  return `# Role & Persona
You are Maverick's elite personal financial strategist, money advisor, and day-to-day financial co-pilot inside Google Gemini.
You have continuous access to Maverick's live FinTrack financial data connected via your Google Drive Knowledge Base ("FinTrack Live Data").

# Core Principles & Directives
1. **Mathematical Rigor:** Always reference exact numbers from the FinTrack data (Primary Checking balance, Credit Card balances, APRs, minimum payments, debts, and upcoming bills). Never guess or hallucinate numbers.
2. **The Affordability Test ("Can I afford X?"):**
   - Step 1: Check Primary Checking balance.
   - Step 2: Check the DEDUCTED_FROM and ACCOUNT_TYPE columns in UPCOMING_BILLS:
     - Bills with ACCOUNT_TYPE "CHECKING" deduct directly from liquid cash before the next expected paycheque.
     - Bills with ACCOUNT_TYPE "CREDIT_CARD" increase credit card balance instead of immediately reducing checking cash.
   - Step 3: Determine the remaining Safe Liquid Float (Primary Checking + Projected Income - Upcoming Checking Bills).
   - Step 4: Deliver a direct verdict: **Yes / Caution / No**, with the exact resulting checking balance, float impact, and any credit card utilization impact.
3. **Debt Strategy:**
   - Recommend the Avalanche method (highest interest APR first) for maximum interest savings, or Snowball for quick psychological wins if requested.
   - Ensure minimum payments on all debts are protected first before allocating surplus float.
4. **Tone & Style:**
   - Address Maverick directly and warmly.
   - Concise, actionable, and structured with clean markdown (bold key dollar figures, bullet points).
   - Avoid generic financial disclaimers; speak as Maverick's trusted, private financial architect.
`;
};

// --- PUBLIC TOKEN-AUTHENTICATED CSV FEED ---
router.get("/financial-feed.csv", async (req, res) => {
  const token = req.query.key;
  if (!token) {
    return res.status(401).send("Error: Missing feed key.");
  }

  const storedToken = await getOrCreateFeedToken();
  if (token !== storedToken) {
    return res.status(401).send("Error: Invalid or revoked feed key.");
  }

  try {
    const data = await getFinancialData();
    const csvContent = generateCSV(data);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="fintrack-live-${data.todayStr}.csv"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(csvContent);
  } catch (err) {
    console.error("CSV feed generation error:", err);
    res.status(500).send("Error generating financial feed.");
  }
});

// --- PUBLIC TOKEN-AUTHENTICATED MARKDOWN FEED ---
router.get("/financial-feed.md", async (req, res) => {
  const token = req.query.key;
  if (!token) {
    return res.status(401).send("Error: Missing feed key.");
  }

  const storedToken = await getOrCreateFeedToken();
  if (token !== storedToken) {
    return res.status(401).send("Error: Invalid or revoked feed key.");
  }

  try {
    const data = await getFinancialData();
    const markdownContent = generateMarkdown(data);

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="fintrack-snapshot-${data.todayStr}.md"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(markdownContent);
  } catch (err) {
    console.error("Markdown feed generation error:", err);
    res.status(500).send("Error generating financial snapshot.");
  }
});

// --- JWT-AUTHENTICATED CONFIGURATION ENDPOINT (FOR FINTRACK UI) ---
router.get("/gemini-config", authMiddleware, async (req, res) => {
  try {
    const feedKey = await getOrCreateFeedToken();
    const host = req.get("host") || "localhost:8000";
    const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    
    // In production on Render or custom domain, build canonical URL
    const baseUrl = process.env.PUBLIC_BACKEND_URL || `${protocol}://${host}`;
    const feedUrl = `${baseUrl}/api/export/financial-feed.csv?key=${feedKey}`;
    const sheetFormula = `=IMPORTDATA("${feedUrl}")`;

    const data = await getFinancialData();
    const markdown = generateMarkdown(data);
    const instructions = generateGemInstructions();

    res.json({
      feedKey,
      feedUrl,
      sheetFormula,
      instructions,
      markdown,
      filename: `fintrack-snapshot-${data.todayStr}.md`,
    });
  } catch (err) {
    console.error("Gemini config export error:", err);
    res.status(500).json({ error: "Failed to load Gemini config." });
  }
});

// --- JWT-AUTHENTICATED KEY REGENERATION ---
router.post("/regenerate-key", authMiddleware, async (req, res) => {
  try {
    const newKey = await regenerateFeedToken();
    const host = req.get("host") || "localhost:8000";
    const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const baseUrl = process.env.PUBLIC_BACKEND_URL || `${protocol}://${host}`;
    const feedUrl = `${baseUrl}/api/export/financial-feed.csv?key=${newKey}`;
    const sheetFormula = `=IMPORTDATA("${feedUrl}")`;

    res.json({
      feedKey: newKey,
      feedUrl,
      sheetFormula,
      message: "Secret feed key regenerated successfully.",
    });
  } catch (err) {
    console.error("Key regeneration error:", err);
    res.status(500).json({ error: "Failed to regenerate feed key." });
  }
});

module.exports = router;
