const express = require("express");
const crypto = require("crypto");
const { getBalancesSummary } = require("../services/netWorthService");
const { toZonedTime, format } = require("date-fns-tz");
const { Op } = require("sequelize");
const { Account, Transaction, Setting, Budget } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { getPaychequeProjection } = require("../services/projectionService");
const { getForecast } = require("../services/forecastService");
const { normalizePayeeTitle } = require("../utils/payeeNormalizer");
const { EXPENSE_CATEGORIES } = require("../constants/categories");
const { feedLimiter } = require("../middleware/rateLimit");

// Helper: Timing-safe token comparison
const constantTimeCompare = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const router = express.Router();
const TIMEZONE = "America/Toronto";
const SETTING_KEY = "gemini_feed_token";
const FORECAST_DAYS = 60;
const RECENT_LIMIT = 50;
const PAYEES_LIMIT = 300;
const HISTORY_MONTHS = 12;
const DEFAULT_FRONTEND_URL = "https://fintrack-frontend-jet.vercel.app";
const getFrontendUrl = () =>
  (process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL).trim().replace(/\/+$/, "");

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

const money = (n) => (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);

// FORECAST section: the forecast service's numbers, unchanged, so the Gem matches the app
const buildForecastSummary = (f) => {
  const lastDay = f.days && f.days.length ? f.days[f.days.length - 1].date : f.today;
  const est = f.estimatedIncome;
  return {
    safeToSpend: f.safeToSpend,
    until: f.nextPayday || lastDay,
    untilNote: f.nextPayday
      ? "Next payday; Safe to Spend covers the days before it"
      : `No payday in the next ${FORECAST_DAYS} days; covers the whole forecast`,
    buffer: f.buffer,
    lowestBalance: f.lowestPoint.balance,
    lowestDate: f.lowestPoint.date,
    nextPayday: f.nextPayday || "",
    estimatedIncomeIncluded: Boolean(est),
    estimatedIncomeNote: est
      ? `Estimated ${est.cadence} paycheque of $${money(est.amount)} on ${est.dates.join("; ")}`
      : "Only income already in FinTrack is counted",
  };
};

// PAYEES section: one row per normalized title over the last 12 months, biggest first.
// rows arrive newest first, so the first row seen for a payee is its latest payment.
const buildPayees = (rows, accountLabel, yearStart) => {
  const byKey = new Map();
  for (const t of rows) {
    const key = normalizePayeeTitle(t.title);
    if (!key) continue;
    const amount = parseFloat(t.amount) || 0;
    let p = byKey.get(key);
    if (!p) {
      p = {
        title: key,
        category: t.type === "TRANSFER" ? "Transfer" : t.category || "Other",
        account: accountLabel(t),
        lastPaidDate: t.date,
        lastAmount: amount,
        times12m: 0,
        total12m: 0,
        totalYtd: 0,
      };
      byKey.set(key, p);
    }
    p.times12m += 1;
    p.total12m += amount;
    if (t.date >= yearStart) p.totalYtd += amount;
  }
  return [...byKey.values()]
    .sort((a, b) => b.total12m - a.total12m || a.title.localeCompare(b.title))
    .slice(0, PAYEES_LIMIT);
};

// MONTHLY_CATEGORIES section: the last 12 months (newest first) x category.
// SPENT counts paid EXPENSEs only (card and debt payments are transfers, not spending).
// Budgets have no history, so BUDGET is today's monthly limit for every month.
const buildMonthlyCategories = (rows, budgets, year, month) => {
  const months = [];
  for (let i = 0; i < HISTORY_MONTHS; i++) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const budgetMap = new Map(budgets.map((b) => [b.category, parseFloat(b.monthlyLimit)]));
  const spent = new Map();
  const categories = new Set([...EXPENSE_CATEGORIES, ...budgetMap.keys()]);
  for (const t of rows) {
    if (t.type !== "EXPENSE") continue;
    const category = t.category || "Other";
    categories.add(category);
    const key = `${t.date.slice(0, 7)}|${category}`;
    spent.set(key, (spent.get(key) || 0) + (parseFloat(t.amount) || 0));
  }
  const out = [];
  for (const m of months) {
    for (const category of categories) {
      out.push({
        month: m,
        category,
        spent: spent.get(`${m}|${category}`) || 0,
        budget: budgetMap.has(category) ? budgetMap.get(category) : null,
      });
    }
  }
  return out;
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
  const generatedAt = format(nowZoned, "yyyy-MM-dd HH:mm", { timeZone: TIMEZONE });
  // History window: the last 12 months, i.e. after this date a year ago
  const historyStart = `${year - 1}${todayStr.slice(4)}`;
  const yearStart = `${year}-01-01`;
  const withAccounts = [
    { model: Account, as: "fromAccount" },
    { model: Account, as: "toAccount" },
  ];

  const [
    accounts,
    monthExpensesSum,
    monthIncomeSum,
    upcomingBills,
    recentTransactions,
    historyRows,
    budgets,
    forecast,
  ] = await Promise.all([
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
          // Card and debt payments are TRANSFERs but still leave checking, so include them
          type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
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
      // Only what has actually happened: paid and dated today or earlier (G3)
      Transaction.findAll({
        where: { isCleared: true, date: { [Op.lte]: todayStr } },
        order: [
          ["date", "DESC"],
          ["createdAt", "DESC"],
        ],
        include: withAccounts,
        limit: RECENT_LIMIT,
      }),
      // Paid money out over the last 12 months, for PAYEES and MONTHLY_CATEGORIES
      Transaction.findAll({
        where: {
          type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
          isCleared: true,
          date: { [Op.gt]: historyStart, [Op.lte]: todayStr },
        },
        order: [
          ["date", "DESC"],
          ["createdAt", "DESC"],
        ],
        include: withAccounts,
      }),
      Budget.findAll(),
      // Same numbers as the app's Safe to Spend card (G1)
      getForecast(FORECAST_DAYS),
    ]);

  const balancesSummary = await getBalancesSummary(null, todayStr);
  const checkingBalance = balancesSummary.checking;
  const totalCC = balancesSummary.cards;
  const totalDebt = balancesSummary.debt;
  const totalSavings = balancesSummary.savings;
  const netWorth = balancesSummary.netWorth;

  const checkingAcc = accounts.find((a) => a.type === "CHECKING");
  const creditCards = accounts.filter((a) => a.type === "CREDIT_CARD");
  const allDebts = accounts.filter((a) => a.type === "DEBT");
  const debts = allDebts.filter(
    (a) => parseFloat(a.initialBalance || 0) > 0 && a.isActive !== false
  );
  const paidOffDebts = allDebts.filter(
    (a) => parseFloat(a.initialBalance || 0) <= 0 || a.isActive === false
  );
  const savingsGoals = accounts.filter((a) => a.type === "SAVINGS_GOAL");
  const clearedIncome = parseFloat(monthIncomeSum || 0);
  const clearedExpenses = parseFloat(monthExpensesSum || 0);
  const netFlow = clearedIncome - clearedExpenses;

  // Paycheque projection for remaining month
  let totalProjectedIncome = 0;
  let projectedPaychequeDates = [];
  try {
    const projection = await getPaychequeProjection(todayStr, currentMonthPrefix);
    totalProjectedIncome = projection.totalProjectedIncome;
    projectedPaychequeDates = projection.projectedPaychequeDates;
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

  const checkingName = checkingAcc ? checkingAcc.name : "Primary Checking";
  const accountLabel = (t) => {
    // No account id means checking; an id with no account means it was deleted
    const name = (acc, id) => (acc ? acc.name : id ? "Deleted account" : checkingName);
    const from = name(t.fromAccount, t.fromAccountId);
    const to = name(t.toAccount, t.toAccountId);
    if (t.type === "INCOME") return to;
    if (t.type === "TRANSFER") {
      // Transfers always name both accounts, and deleting a card, debt or goal nulls the id,
      // so a missing one is a deleted account. Its name is usually still in the title.
      if (t.toAccount || t.toAccountId) return `${from} → ${to}`;
      const titled = /^(?:payment for|auto-pay for|contribution to)\s+(.+)$/i.exec(t.title || "");
      return `${from} → ${titled ? `${titled[1]} (deleted)` : "Deleted account"}`;
    }
    return from;
  };

  const forecastSummary = buildForecastSummary(forecast);
  const payees = buildPayees(historyRows, accountLabel, yearStart);
  const monthlyCategories = buildMonthlyCategories(historyRows, budgets, year, month);

  return {
    todayStr,
    generatedAt,
    forecast: forecastSummary,
    payees,
    monthlyCategories,
    accountLabel,
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
    paidOffDebts,
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
  const push = (...cols) => rows.push(cols.map(csvEscape).join(","));
  const f = d.forecast;

  // First row: when this snapshot was taken, so the Gem can tell how fresh it is
  push("SNAPSHOT_AT", d.generatedAt, "America/Toronto");
  rows.push([]);

  // 1. FORECAST (the app's Safe to Spend; use this for affordability)
  push("SECTION", "METRIC", "VALUE", "NOTES");
  push("FORECAST", "SAFE_TO_SPEND", money(f.safeToSpend), "Same as the app's Safe to Spend. Use this for every affordability answer.");
  push("FORECAST", "UNTIL", f.until, f.untilNote);
  push("FORECAST", "BUFFER", money(f.buffer), "Cushion already kept back from SAFE_TO_SPEND");
  push("FORECAST", "LOWEST_BALANCE", money(f.lowestBalance), `Lowest projected checking balance in the next ${FORECAST_DAYS} days`);
  push("FORECAST", "LOWEST_DATE", f.lowestDate, "Date of LOWEST_BALANCE");
  push("FORECAST", "NEXT_PAYDAY", f.nextPayday, f.nextPayday ? "" : `No income expected in the next ${FORECAST_DAYS} days`);
  push("FORECAST", "ESTIMATED_INCOME_INCLUDED", f.estimatedIncomeIncluded ? "YES" : "NO", f.estimatedIncomeNote);

  // 2. OVERVIEW
  rows.push([]);
  rows.push(["SECTION", "CATEGORY", "METRIC", "VALUE", "NOTES"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Snapshot", "Snapshot Date", d.todayStr, "Timezone: America/Toronto"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Accounts", "Primary Checking Balance", `$${d.checkingBalance.toFixed(2)}`, "Available liquid cash"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Accounts", "Estimated Net Worth", `$${d.netWorth.toFixed(2)}`, "Checking + Savings - Debts - Cards"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Cash Flow", "Month Cleared Income", `$${d.clearedIncome.toFixed(2)}`, "Total deposits cleared this month"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Cash Flow", "Month Cleared Spending", `$${d.clearedExpenses.toFixed(2)}`, "Total paid spending this month"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Cash Flow", "Current Net Cash Flow", `$${d.netFlow.toFixed(2)}`, "Cleared Income minus Cleared Spending"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Projected Upcoming Income", `$${d.totalProjectedIncome.toFixed(2)}`, `Context only, this month only: ${d.projectedPaychequeDates.join("; ") || "none this month"}. For the next payday use FORECAST NEXT_PAYDAY.`].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Upcoming Unpaid Bills Total", `$${d.upcomingBillsTotal.toFixed(2)}`, "Context only: unpaid bills left this month"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Upcoming Bills (From Checking)", `$${d.upcomingCheckingBillsTotal.toFixed(2)}`, "Bills directly deducting liquid cash from Primary Checking"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Upcoming Bills (On Credit Cards)", `$${d.upcomingCCBillsTotal.toFixed(2)}`, "Bills charged to credit cards (adds to card balance)"].map(csvEscape).join(","));
  rows.push(["OVERVIEW", "Projections", "Projected End-of-Month Float", `$${d.endOfMonthFloat.toFixed(2)}`, "Context only, rest of this month. For affordability use FORECAST SAFE_TO_SPEND."].map(csvEscape).join(","));

  // 3. ACCOUNTS & LIABILITIES
  rows.push([]);
  rows.push(["SECTION", "TYPE", "ACCOUNT_NAME", "CURRENT_BALANCE", "LIMIT_OR_TARGET", "INTEREST_RATE_PCT", "MIN_PAYMENT", "STATUS"].map(csvEscape).join(","));
  if (d.checkingAcc) {
    rows.push(["ACCOUNTS", "CHECKING", d.checkingAcc.name, d.checkingBalance.toFixed(2), "", "", "", "ACTIVE"].map(csvEscape).join(","));
  }
  for (const c of d.creditCards) {
    rows.push(["ACCOUNTS", "CREDIT_CARD", c.name, parseFloat(c.initialBalance || 0).toFixed(2), parseFloat(c.creditLimit || 0).toFixed(2), c.interestRate ? `${c.interestRate}%` : "", c.minimumPayment ? parseFloat(c.minimumPayment).toFixed(2) : "", "ACTIVE"].map(csvEscape).join(","));
  }
  for (const debt of d.debts) {
    rows.push(["ACCOUNTS", "DEBT", debt.name, parseFloat(debt.initialBalance || 0).toFixed(2), parseFloat(debt.targetAmount || debt.initialBalance || 0).toFixed(2), debt.interestRate ? `${debt.interestRate}%` : "", debt.minimumPayment ? parseFloat(debt.minimumPayment).toFixed(2) : "", "ACTIVE"].map(csvEscape).join(","));
  }
  for (const debt of d.paidOffDebts || []) {
    rows.push(["ACCOUNTS", "DEBT", debt.name, "0.00", parseFloat(debt.targetAmount || debt.initialBalance || 0).toFixed(2), debt.interestRate ? `${debt.interestRate}%` : "", "0.00", "PAID_OFF"].map(csvEscape).join(","));
  }
  for (const g of d.savingsGoals) {
    rows.push(["ACCOUNTS", "SAVINGS_GOAL", g.name, parseFloat(g.initialBalance || 0).toFixed(2), parseFloat(g.targetAmount || 0).toFixed(2), "", "", "ACTIVE"].map(csvEscape).join(","));
  }

  // 4. UPCOMING UNPAID BILLS
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

  // 5. RECENT TRANSACTIONS (paid, dated today or earlier)
  rows.push([]);
  push("SECTION", "DATE", "TYPE", "CATEGORY", "TITLE", "AMOUNT", "ACCOUNT");
  for (const t of d.recentTransactions) {
    push("RECENT_TRANSACTIONS", t.date, t.type, t.category, t.title, money(t.amount), d.accountLabel(t));
  }

  // 6. PAYEES (last 12 months, biggest first)
  rows.push([]);
  push("SECTION", "TITLE", "CATEGORY", "ACCOUNT", "LAST_PAID_DATE", "LAST_AMOUNT", "TIMES_12M", "TOTAL_12M", "TOTAL_YTD");
  for (const p of d.payees) {
    push("PAYEES", p.title, p.category, p.account, p.lastPaidDate, money(p.lastAmount), p.times12m, money(p.total12m), money(p.totalYtd));
  }

  // 7. MONTHLY_CATEGORIES (last 12 months x category)
  rows.push([]);
  push("SECTION", "MONTH", "CATEGORY", "SPENT", "BUDGET");
  for (const m of d.monthlyCategories) {
    push("MONTHLY_CATEGORIES", m.month, m.category, money(m.spent), m.budget === null ? "" : money(m.budget));
  }

  return rows.join("\n");
};

const mdCell = (val) => String(val ?? "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");

// Helper: Generate structured Markdown
const generateMarkdown = (d) => {
  return `# FINTRACK FINANCIAL SNAPSHOT
**Generated:** ${d.generatedAt} (America/Toronto)
**Owner:** Maverick

---

## Forecast (the app's Safe to Spend)
- **SAFE_TO_SPEND:** **$${money(d.forecast.safeToSpend)}** (use this for every affordability answer)
- **UNTIL:** ${d.forecast.until} (${d.forecast.untilNote})
- **BUFFER:** $${money(d.forecast.buffer)}
- **LOWEST_BALANCE:** $${money(d.forecast.lowestBalance)}
- **LOWEST_DATE:** ${d.forecast.lowestDate}
- **NEXT_PAYDAY:** ${d.forecast.nextPayday || "none in the next " + FORECAST_DAYS + " days"}
- **ESTIMATED_INCOME_INCLUDED:** ${d.forecast.estimatedIncomeIncluded ? "YES" : "NO"} (${d.forecast.estimatedIncomeNote})

---

## 1. Executive Summary
- **Primary Checking Balance:** $${d.checkingBalance.toFixed(2)}
- **Estimated Net Worth:** $${d.netWorth.toFixed(2)}
- **Current Month Cleared Income:** $${d.clearedIncome.toFixed(2)}
- **Current Month Cleared Spending:** $${d.clearedExpenses.toFixed(2)}
- **Current Net Cash Flow:** $${d.netFlow.toFixed(2)}
- **Projected Upcoming Income (this month, context only):** $${d.totalProjectedIncome.toFixed(2)} (${d.projectedPaychequeDates.length} paycheques left this month; for the next payday use NEXT_PAYDAY above)
- **Upcoming Unpaid Bills Total:** $${d.upcomingBillsTotal.toFixed(2)}
- **Projected End-of-Month Float (context only):** $${d.endOfMonthFloat.toFixed(2)}

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

#### Active Debts
${
  d.debts.length === 0
    ? "_No active debts._"
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

#### Paid Off & Cleared Debts
${
  (d.paidOffDebts || []).length === 0
    ? "_No paid-off debts._"
    : d.paidOffDebts
        .map(
          (debt) =>
            `- **${debt.name}:** Balance $0.00 (✓ Paid in Full — $${parseFloat(
              debt.targetAmount || debt.initialBalance || 0
            ).toFixed(2)} total cleared, $0.00 payment due)`
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

## 4. Recent Transactions Ledger (Last ${RECENT_LIMIT} paid, today or earlier)
| Date | Type | Category | Description | Amount | Account |
| :--- | :--- | :--- | :--- | :--- | :--- |
${d.recentTransactions
  .map(
    (t) =>
      `| ${t.date} | ${t.type} | ${t.category} | ${mdCell(t.title)} | $${money(t.amount)} | ${mdCell(d.accountLabel(t))} |`
  )
  .join("\n")}

---

## 5. Payees (last 12 months)
| Title | Category | Account | Last Paid | Last Amount | Times (12m) | Total (12m) | Total (YTD) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${d.payees
  .map(
    (p) =>
      `| ${mdCell(p.title)} | ${mdCell(p.category)} | ${mdCell(p.account)} | ${p.lastPaidDate} | $${money(p.lastAmount)} | ${p.times12m} | $${money(p.total12m)} | $${money(p.totalYtd)} |`
  )
  .join("\n")}

---

## 6. Monthly Categories (last 12 months)
| Month | Category | Spent | Budget |
| :--- | :--- | :--- | :--- |
${d.monthlyCategories
  .map(
    (m) =>
      `| ${m.month} | ${mdCell(m.category)} | $${money(m.spent)} | ${m.budget === null ? "" : `$${money(m.budget)}`} |`
  )
  .join("\n")}
`;
};

// Helper: Generate specialized Gem instructions
const generateGemInstructions = (frontendUrl = getFrontendUrl()) => {
  return `# Role & Persona
You are Maverick's elite personal financial strategist, money advisor, and day-to-day financial co-pilot inside Google Gemini.
You have continuous access to Maverick's live FinTrack financial data connected via your Google Drive Knowledge Base ("FinTrack Live Data").

# Core Principles & Directives
1. **Mathematical Rigor:** Always reference exact numbers from the FinTrack data (Primary Checking balance, Credit Card balances, APRs, minimum payments, debts, and upcoming bills). Never guess or hallucinate numbers.
2. **Freshness:** The first row (SNAPSHOT_AT) says when the data was taken, in Toronto time. If it is more than 24 hours old, start your answer with "Data as of <SNAPSHOT_AT>".
3. **The Affordability Test ("Can I afford X?"):**
   - Use FORECAST SAFE_TO_SPEND. It is the same number the FinTrack app shows, and it already accounts for upcoming bills, expected income (see ESTIMATED_INCOME_INCLUDED) and the BUFFER until the UNTIL date.
   - NEVER compute your own affordability or "safe float" from balances, bills or income. The OVERVIEW "Projected End-of-Month Float" is context only.
   - Verdict: **Yes** if the amount is comfortably under SAFE_TO_SPEND, **Caution** if it uses most of it, **No** if it is over it. Quote SAFE_TO_SPEND, what would be left of it, and the UNTIL date.
   - For a purchase on a credit card, also mention the card's balance and limit from ACCOUNTS.
   - If LOWEST_BALANCE is low, mention LOWEST_DATE as the tight day.
4. **History Questions ("How much did I spend on X?", "When did I last pay Y?"):**
   - Use PAYEES (per payee: last paid date and amount, times and totals for the last 12 months and year to date) and MONTHLY_CATEGORIES (spent and budget per category for each of the last 12 months). RECENT_TRANSACTIONS has the last ${RECENT_LIMIT} paid transactions with their ACCOUNT.
   - If the answer is not in these sections, say so plainly. Do not estimate or guess history.
5. **Adding, Recording or Logging ("add", "record", "log", "I spent ..."):**
   - You cannot save anything. NEVER say or imply that something was saved, added or recorded.
   - Reply with a link Maverick taps to review and save it in FinTrack: ${frontendUrl}/quick?text=<url-encoded Quick Add text>
   - Quick Add format, one line per item: \`amount description [card] [due MM/DD]\`. Use \`+amount\` for income. Add the card name only for card purchases, and "due MM/DD" only for a bill that is not paid yet.
   - Examples: "23.40 lunch visa", "120 hydro due 11/05", "+2100 paycheque".
   - URL-encode the text: spaces as %20, a new line between items as %0A, and the income \`+\` as %2B (a bare + in a link turns into a space and the income becomes an expense). Example with an expense and an income: ${frontendUrl}/quick?text=23.40%20lunch%20visa%0A%2B2100%20paycheque
6. **Debt Strategy & Paid-Off Debts:**
   - Only consider debts with STATUS "ACTIVE" as active liabilities requiring payment.
   - Debts with STATUS "PAID_OFF" or listed under "Paid Off & Cleared Debts" are 100% paid off ($0 balance, $0 payment due).
   - NEVER suggest or calculate payments for paid-off debts. Congratulate Maverick for having eliminated them!
   - For active debts, recommend the Avalanche method (highest interest APR first) for maximum interest savings, or Snowball for quick psychological wins if requested.
   - Ensure minimum payments on active debts are protected first before allocating surplus.
7. **Tone & Style:**
   - Address Maverick directly and warmly.
   - Concise, actionable, and structured with clean markdown (bold key dollar figures, bullet points).
   - Avoid generic financial disclaimers; speak as Maverick's trusted, private financial architect.
`;
};

router.use(["/financial-feed.csv", "/financial-feed.md"], feedLimiter);

// --- PUBLIC TOKEN-AUTHENTICATED CSV FEED ---
router.get("/financial-feed.csv", async (req, res) => {
  const token = req.query.key;
  if (!token) {
    return res.status(401).send("Error: Missing feed key.");
  }

  const storedToken = await getOrCreateFeedToken();
  if (!constantTimeCompare(token, storedToken)) {
    return res.status(401).send("Error: Invalid or revoked feed key.");
  }

  try {
    const data = await getFinancialData();
    const csvContent = generateCSV(data);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="fintrack-live-${data.todayStr}.csv"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0, s-maxage=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
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
  if (!constantTimeCompare(token, storedToken)) {
    return res.status(401).send("Error: Invalid or revoked feed key.");
  }

  try {
    const data = await getFinancialData();
    const markdownContent = generateMarkdown(data);

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="fintrack-snapshot-${data.todayStr}.md"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0, s-maxage=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.status(200).send(markdownContent);
  } catch (err) {
    console.error("Markdown feed generation error:", err);
    res.status(500).send("Error generating financial snapshot.");
  }
});

// Helper: Generate Apps Script for the Sheet the Gem reads
const generateAppsScript = (feedUrl) => {
  return `/**
 * FinTrack Auto-Sync Script for Google Sheets
 * - Run installTrigger() once: it refreshes the sheet every hour, even when it's closed.
 * - Adds a "FinTrack > 🔄 Refresh Data Now" menu for 1-click sync.
 * - Writes to its own "FinTrack" tab (created if missing); other tabs are left alone.
 * - The first row (SNAPSHOT_AT) is the date and time of the data, in Toronto time.
 * - Bypasses Google formula proxy caching for 100% real-time accuracy.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("FinTrack")
    .addItem("🔄 Refresh Data Now", "refreshFinTrack")
    .addToUi();
  refreshFinTrack();
}

// Run once from the Apps Script editor. Replaces any earlier refresh triggers with one hourly trigger.
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "refreshFinTrack") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("refreshFinTrack").timeBased().everyHours(1).create();
  refreshFinTrack();
}

function refreshFinTrack() {
  const url = "${feedUrl}&t=" + new Date().getTime();
  try {
    const response = UrlFetchApp.fetch(url, {
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
      muteHttpExceptions: true,
    });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (response.getResponseCode() === 200) {
      const csvData = Utilities.parseCsv(response.getContentText());
      // Sections have different widths; setValues needs every row the same length
      const width = csvData.reduce(function (max, row) { return Math.max(max, row.length); }, 1);
      const values = csvData.map(function (row) {
        while (row.length < width) row.push("");
        return row;
      });
      // Its own tab, so the hourly trigger (which has no open tab) writes to the same place
      // and never clears a tab Maverick uses for something else
      const sheet = ss.getSheetByName("FinTrack") || ss.insertSheet("FinTrack");
      sheet.clearContents();
      sheet.getRange(1, 1, values.length, width).setValues(values);
      ss.toast("FinTrack numbers synchronized successfully!", "Live Sync", 3);
    } else {
      ss.toast("HTTP " + response.getResponseCode() + ": Feed fetch failed.", "Sync Warning", 5);
    }
  } catch (err) {
    Logger.log("FinTrack Sync Error: " + err.message);
  }
}`;
};

// --- JWT-AUTHENTICATED CONFIGURATION ENDPOINT (FOR FINTRACK UI) ---
// Feed URLs end up in spreadsheets, so production never builds them from request headers (S7).
// PUBLIC_BACKEND_URL overrides the Render default (e.g. for a custom domain).
const DEFAULT_PRODUCTION_BACKEND_URL = "https://fintrack-backend-rzrh.onrender.com";
const getPublicBaseUrl = (req) => {
  if (process.env.PUBLIC_BACKEND_URL) {
    return process.env.PUBLIC_BACKEND_URL.replace(/\/+$/, "");
  }
  if (process.env.NODE_ENV === "production") return DEFAULT_PRODUCTION_BACKEND_URL;
  return `${req.protocol}://${req.get("host") || "localhost:8000"}`;
};

const MISSING_PUBLIC_URL_ERROR =
  "PUBLIC_BACKEND_URL is not configured on the server, so the feed URL cannot be built.";

router.get("/gemini-config", authMiddleware, async (req, res) => {
  try {
    const baseUrl = getPublicBaseUrl(req);
    if (!baseUrl) {
      return res.status(503).json({ error: MISSING_PUBLIC_URL_ERROR });
    }
    const feedKey = await getOrCreateFeedToken();
    const feedUrl = `${baseUrl}/api/export/financial-feed.csv?key=${feedKey}`;
    const sheetFormula = `=IMPORTDATA("${feedUrl}&t=" & TEXT(NOW(), "yyyyMMddhhmm"))`;

    const data = await getFinancialData();
    const markdown = generateMarkdown(data);
    const instructions = generateGemInstructions();
    const appsScript = generateAppsScript(feedUrl);

    res.json({
      feedKey,
      feedUrl,
      sheetFormula,
      appsScript,
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
    const baseUrl = getPublicBaseUrl(req);
    if (!baseUrl) {
      return res.status(503).json({ error: MISSING_PUBLIC_URL_ERROR });
    }
    const newKey = await regenerateFeedToken();
    const feedUrl = `${baseUrl}/api/export/financial-feed.csv?key=${newKey}`;
    const sheetFormula = `=IMPORTDATA("${feedUrl}&t=" & TEXT(NOW(), "yyyyMMddhhmm"))`;
    const appsScript = generateAppsScript(feedUrl);

    res.json({
      feedKey: newKey,
      feedUrl,
      sheetFormula,
      appsScript,
      message: "Secret feed key regenerated successfully.",
    });
  } catch (err) {
    console.error("Key regeneration error:", err);
    res.status(500).json({ error: "Failed to regenerate feed key." });
  }
});

module.exports = router;
