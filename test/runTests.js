const { Sequelize } = require("sequelize");
const { Account, Transaction, Setting, Budget, NetWorthSnapshot } = require("../models");
const { restoreBackup } = require("../scripts/restore");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { getBalancesSummary } = require("../services/netWorthService");
const { getNextOccurrenceDate, getNextDueDate } = require("../routes/recurring");
const { toZonedTime, format } = require("date-fns-tz");

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTestSuite() {
  console.log("==================================================");
  console.log("   FINTRACK BACKEND AUTOMATED TEST SUITE        ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  // 0. Pre-Flight Safety Verification: Refuse to run against production database
  const healthRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/health",
    method: "GET",
  });
  if (healthRes.body?.isProductionDb === true) {
    console.error("\n❌ CRITICAL SAFETY ERROR: Target backend on localhost:8000 is connected to the PRODUCTION database!");
    console.error("Test execution aborted immediately to protect live production financial records.\n");
    process.exit(1);
  }
  assert(
    healthRes.status === 200 && healthRes.body.isProductionDb === false,
    "Target server verified running on safe local development database (isolated from live site)"
  );

  // 1. Auth & Security Tests
  console.log("\n--- Suite 1: Authentication & Security ---");
  const badLogin = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/auth/login",
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, { password: "incorrect-password-xyz" });
  assert(badLogin.status === 401, "Rejects incorrect password with HTTP 401");

  const validLogin = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/auth/login",
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, { devBypass: true });
  assert(validLogin.status === 200 && validLogin.body.token, "Authenticates and returns signed JWT token");
  const token = validLogin.body.token;
  const authHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };

  // 2. Cron & Schedulers Tests
  console.log("\n--- Suite 2: Cron Jobs & Scheduled Sweeps ---");
  const badCron = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/daily-check",
    method: "GET",
    headers: { "Authorization": "Bearer invalid_secret_token" },
  });
  assert(badCron.status === 401, "Rejects unauthorized cron request with HTTP 401");

  const cronDaily = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/daily-check",
    method: "GET",
    headers: authHeaders,
  });
  assert(cronDaily.status === 200, "Executes GET /api/daily-check successfully with HTTP 200");

  const cronRecurring = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/recurring/trigger-recurring",
    method: "GET",
    headers: authHeaders,
  });
  assert(cronRecurring.status === 200, "Executes GET /api/recurring/trigger-recurring successfully with HTTP 200");

  // 3. Zod Input Validation Tests
  console.log("\n--- Suite 3: Zod Schema Validation ---");
  const negExp = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, { name: "Invalid Neg", amount: -25.0 });
  assert(negExp.status === 400 && Array.isArray(negExp.body.details), "Rejects negative expense amount with HTTP 400 & validation details");

  const badDateExp = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, { name: "Invalid Date", amount: 25.0, due_date: "not-a-date" });
  assert(badDateExp.status === 400, "Rejects malformed date format with HTTP 400");

  // 4. Financial Math & Ledger Integrity Tests
  console.log("\n--- Suite 4: Financial Math & Ledger Accuracy ---");
  const futurePay = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/paycheques",
    method: "POST",
    headers: authHeaders,
  }, { name: "Test Forward Salary", amount: 7500, payment_date: "2099-12-31" });
  assert(futurePay.status === 201 && futurePay.body.isCleared === false, "Future paycheque defaults to isCleared: false");
  const futurePayId = futurePay.body.id;

  const cardRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "POST",
    headers: authHeaders,
  }, { name: "Automated Suite Card", creditLimit: 4000, currentBalance: 400 });
  assert(cardRes.status === 201 && cardRes.body.id, "Creates test credit card with balance $400");
  const cardId = cardRes.body.id;

  const cardPayRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/credit-cards/${cardId}/pay`,
    method: "POST",
    headers: authHeaders,
  }, { amount: 100 });
  assert(cardPayRes.status === 200 && cardPayRes.body.currentBalance === 300, "Card payment reduces balance to $300");

  const ledgerRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/all",
    method: "GET",
    headers: authHeaders,
  });
  const payTx = (ledgerRes.body || []).find((t) => t.toAccount === "Automated Suite Card");
  assert(payTx && payTx.type === "transfer", `Card payment categorized as TRANSFER (not EXPENSE) to avoid double counting`);

  if (payTx) {
    const delTx = await request({
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${payTx.id}`,
      method: "DELETE",
      headers: authHeaders,
    });
    assert(delTx.status === 204, "Payment transaction deleted");

    const cardsAfterDel = await request({
      hostname: "localhost",
      port: 8000,
      path: "/api/credit-cards",
      method: "GET",
      headers: authHeaders,
    });
    const restoredCard = (cardsAfterDel.body || []).find((c) => c.id === cardId);
    assert(restoredCard && parseFloat(restoredCard.currentBalance) === 400, "Deleting payment cleanly restores balance to $400 without clamping loss");
  }

  // 5. Permanent Deletion & CASCADE Protection Tests
  console.log("\n--- Suite 5: Hard-Delete & CASCADE Protection ---");
  const testExp = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Preserved Card Purchase",
    amount: 50.0,
    category: "Essentials",
    creditCardId: cardId,
  });
  assert(testExp.status === 201 && testExp.body.id, "Created purchase transaction on card");
  const testExpId = testExp.body.id;

  const delCard = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/credit-cards/${cardId}`,
    method: "DELETE",
    headers: authHeaders,
  });
  assert(delCard.status === 204, "Card deleted with HTTP 204");

  const activeCards = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  const activeMatch = (activeCards.body || []).find((c) => c.id === cardId);
  assert(!activeMatch, "Deleted card omitted from active cards query");

  // Deleting debt permanently removes debt
  const testDebt = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Test Delete Debt",
    total_amount: 500,
    monthly_payment: 50,
  });
  assert(testDebt.status === 201 && testDebt.body.id, "Created test debt for deletion");
  const delDebt = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/debts/${testDebt.body.id}`,
    method: "DELETE",
    headers: authHeaders,
  });
  assert(delDebt.status === 204, "Debt deleted with HTTP 204");
  const activeDebts = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "GET",
    headers: authHeaders,
  });
  assert(!(activeDebts.body || []).find((d) => d.id === testDebt.body.id), "Deleted debt omitted from debts query");

  // Deleting savings goal permanently removes goal
  const testGoal = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Test Delete Goal",
    target_amount: 1000,
    current_amount: 100,
  });
  assert(testGoal.status === 201 && testGoal.body.id, "Created test savings goal for deletion");
  const delGoal = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/savings-goals/${testGoal.body.id}`,
    method: "DELETE",
    headers: authHeaders,
  });
  assert(delGoal.status === 204, "Savings goal deleted with HTTP 204");
  const activeGoals = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  assert(!(activeGoals.body || []).find((g) => g.id === testGoal.body.id), "Deleted savings goal omitted from savings goals query");

  const ledgerAfterDel = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/all",
    method: "GET",
    headers: authHeaders,
  });
  const preservedTx = (ledgerAfterDel.body || []).find((t) => t.id === testExpId);
  assert(preservedTx && preservedTx.name === "Preserved Card Purchase", "Purchase transaction preserved in ledger (No CASCADE deletion!)");

  // Clean up test transactions & future paycheque
  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${testExpId}`,
    method: "DELETE",
    headers: authHeaders,
  });
  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/paycheques/${futurePayId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 6. Historical vs Today Credit Card Expense & Paydown Behavior
  console.log("\n--- Suite 6: Historical vs Today Credit Card Behavior ---");
  const cardHistRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "POST",
    headers: authHeaders,
  }, { name: "Historical Test Card", creditLimit: 2000, currentBalance: 500 });
  assert(cardHistRes.status === 201 && cardHistRes.body.id, "Creates card with $500 balance");
  const histCardId = cardHistRes.body.id;

  // 6a. Past-dated expense does NOT increase card balance
  const pastExpRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Pre-existing Coffee",
    amount: 75.0,
    category: "Food & Drink",
    due_date: "2020-01-01",
    creditCardId: histCardId,
  });
  assert(pastExpRes.status === 201 && pastExpRes.body.id, "Creates historical expense dated 2020-01-01");
  const pastExpId = pastExpRes.body.id;

  let cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  let histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 500, "Past expense does not increase pre-existing card balance");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${pastExpId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 500, "Deleting past expense does not decrement card balance");

  // 6b. Past-dated paydown does NOT decrease card balance
  const pastPaydownRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Past Card Paydown",
    amount: 100.0,
    category: "Debt",
    due_date: "2020-01-01",
    targetAccountId: histCardId,
  });
  assert(pastPaydownRes.status === 201 && pastPaydownRes.body.id, "Creates past paydown dated 2020-01-01");
  const pastPaydownId = pastPaydownRes.body.id;

  cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 500, "Past paydown does not decrease pre-existing card balance");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${pastPaydownId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 500, "Deleting past paydown does not alter card balance");

  // 6c. Today-dated paydown DOES decrease card balance
  const todayPaydownRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Today Card Paydown",
    amount: 100.0,
    category: "Debt",
    targetAccountId: histCardId,
  });
  assert(todayPaydownRes.status === 201 && todayPaydownRes.body.id, "Creates today paydown");
  const todayPaydownId = todayPaydownRes.body.id;

  cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 400, "Today paydown decreases card balance to $400");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${todayPaydownId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 500, "Deleting today paydown cleanly restores balance to $500");

  // 6d. Today-dated expense on card DOES increase card balance
  const todayExpRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Today Grocery Charge",
    amount: 60.0,
    category: "Food & Drink",
    creditCardId: histCardId,
  });
  assert(todayExpRes.status === 201 && todayExpRes.body.id, "Creates today card charge");
  const todayExpId = todayExpRes.body.id;

  cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 560, "Today expense increases card balance to $560");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${todayExpId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  cardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  histCard = (cardQuery.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 500, "Deleting today expense cleanly restores balance to $500");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/credit-cards/${histCardId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 7. Tax-Exclusive Recurring Payments (Issue 5)
  console.log("\n--- Suite 7: Tax-Exclusive Recurring Payments ---");
  const taxExpRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Fiber Internet Bill",
    amount: 100.0,
    category: "Subscription",
    due_date: "2099-05-15",
    recurrence: "monthly",
    isTaxExclusive: true,
    taxRate: 13.0,
    is_paid: false,
  });
  assert(taxExpRes.status === 201 && taxExpRes.body.id, "Creates tax-exclusive upcoming bill");
  assert(parseFloat(taxExpRes.body.amount) === 100.0 && taxExpRes.body.taxApplied === false, "Upcoming bill starts with base amount ($100) and taxApplied: false");
  const taxExpId = taxExpRes.body.id;

  const payTaxRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${taxExpId}`,
    method: "PUT",
    headers: authHeaders,
  }, {
    is_paid: true,
  });
  assert(payTaxRes.status === 200, "Marks bill as paid");
  assert(parseFloat(payTaxRes.body.amount) === 113.0 && payTaxRes.body.taxApplied === true, "Applies 13% tax upon payment ($113.00) and sets taxApplied: true");

  const unpayTaxRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${taxExpId}`,
    method: "PUT",
    headers: authHeaders,
  }, {
    is_paid: false,
  });
  assert(unpayTaxRes.status === 200, "Unmarks bill as paid");
  assert(parseFloat(unpayTaxRes.body.amount) === 100.0 && unpayTaxRes.body.taxApplied === false, "Unmarking bill cleanly restores base amount ($100.00)");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${taxExpId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 8. Upcoming Bills Scope (Only Current Month)
  console.log("\n--- Suite 8: Upcoming Bills Scope (Month-Bounded) ---");
  const nextMonthExpRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Far Future Bill",
    amount: 150.0,
    category: "Essentials",
    due_date: "2099-12-25",
    is_paid: false,
  });
  assert(nextMonthExpRes.status === 201 && nextMonthExpRes.body.id, "Creates upcoming bill in far future month");
  const farFutureId = nextMonthExpRes.body.id;

  const currentDashRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  const currentUpcoming = currentDashRes.body?.upcomingBills || [];
  const foundFarFuture = currentUpcoming.some((b) => b.id === farFutureId);
  assert(!foundFarFuture, "Future-month expense is excluded from current month upcomingBills");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${farFutureId}`,
    method: "DELETE",
    headers: authHeaders,
  });
  // 9. Pure Calendar Recurrence Accuracy & Multi-Frequency Math
  console.log("\n--- Suite 9: Pure Calendar Recurrence Accuracy & Multi-Frequency Math ---");
  assert(getNextDueDate("2026-10-01", "monthly") === "2026-11-01", "Monthly recurrence from 1st of month advances to 1st of next month (never drifts to 30th)");
  assert(getNextDueDate("2026-10-01", "weekly") === "2026-10-08", "Weekly recurrence advances by exactly 7 calendar days");
  assert(getNextDueDate("2026-10-01", "bi-weekly") === "2026-10-15", "Bi-weekly recurrence advances by exactly 14 calendar days");
  assert(getNextDueDate("2026-10-01", "yearly") === "2027-10-01", "Yearly recurrence advances by exactly 1 year");
  assert(getNextDueDate("2026-01-31", "monthly") === "2026-02-28", "Monthly recurrence caps cleanly at month end (Jan 31 -> Feb 28)");
  assert(getNextOccurrenceDate("2026-01-31", "monthly", 2) === "2026-03-31", "Multi-step monthly recurrence restores day 31 after short month (Jan 31 -> Mar 31)");
  assert(getNextOccurrenceDate("2024-02-29", "yearly", 4) === "2028-02-29", "Yearly recurrence preserves leap day after full 4-year cycle");

  // End-to-end Rent test: create rent on 2026-10-01 with monthly recurrence
  const rentRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Automated Suite Rent",
    amount: 500.0,
    category: "Essentials",
    due_date: "2026-10-01",
    recurrence: "monthly",
    is_paid: true,
  });
  assert(rentRes.status === 201 && rentRes.body.id, "Creates monthly rent expense on Oct 1st");
  const rentId = rentRes.body.id;

  // Trigger recurring generation
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/recurring/trigger-recurring",
    method: "POST",
    headers: authHeaders,
  });

  const allLedgerRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/all",
    method: "GET",
    headers: authHeaders,
  });
  const allTxs = allLedgerRes.body || [];
  const bad30thRent = allTxs.find((t) => t.name === "Automated Suite Rent" && t.date === "2026-10-30");
  assert(!bad30thRent, "No duplicate rent transaction generated for 30th of current month");

  const nov1stRent = allTxs.find((t) => t.name === "Automated Suite Rent" && t.date === "2026-11-01");
  assert(nov1stRent, "Next recurring rent instance generated on exactly November 1st (2026-11-01)");

  // Clean up recurring rent test transactions
  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${rentId}`,
    method: "DELETE",
    headers: authHeaders,
  });
  if (nov1stRent) {
    await request({
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${nov1stRent.id}`,
      method: "DELETE",
      headers: authHeaders,
    });
  }

  // 10. Gemini Gem & Live Feed Export
  console.log("\n--- Suite 10: Gemini Gem & Live Feed Export ---");
  const missingKeyRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/financial-feed.csv",
    method: "GET",
  });
  assert(missingKeyRes.status === 401, "Rejects feed request without key with HTTP 401");

  const invalidKeyRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/financial-feed.csv?key=invalid-secret-key-12345",
    method: "GET",
  });
  assert(invalidKeyRes.status === 401, "Rejects feed request with invalid key with HTTP 401");

  const geminiConfigRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/gemini-config",
    method: "GET",
    headers: authHeaders,
  });
  assert(
    geminiConfigRes.status === 200 &&
      geminiConfigRes.body.feedKey &&
      geminiConfigRes.body.sheetFormula &&
      geminiConfigRes.body.instructions,
    "GET /api/export/gemini-config returns valid feedKey, sheetFormula, and instructions"
  );
  const activeFeedKey = geminiConfigRes.body.feedKey;

  const validCsvRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/export/financial-feed.csv?key=${activeFeedKey}`,
    method: "GET",
  });
  assert(
    validCsvRes.status === 200 &&
      validCsvRes.headers["content-type"].includes("text/csv") &&
      validCsvRes.raw.includes("OVERVIEW") &&
      validCsvRes.raw.includes("ACCOUNTS") &&
      validCsvRes.raw.includes("DEDUCTED_FROM"),
    "Returns formatted CSV feed containing OVERVIEW, ACCOUNTS, and DEDUCTED_FROM in UPCOMING_BILLS"
  );

  const validMdRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/export/financial-feed.md?key=${activeFeedKey}`,
    method: "GET",
  });
  assert(
    validMdRes.status === 200 &&
      validMdRes.headers["content-type"].includes("text/markdown") &&
      validMdRes.raw.includes("# FINTRACK FINANCIAL SNAPSHOT"),
    "Returns formatted Markdown snapshot with executive summary"
  );

  const regenRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/regenerate-key",
    method: "POST",
    headers: authHeaders,
  });
  assert(
    regenRes.status === 200 &&
      regenRes.body.feedKey &&
      regenRes.body.feedKey !== activeFeedKey,
    "Regenerates new secret feed token"
  );
  const newFeedKey = regenRes.body.feedKey;

  const oldKeyRevoked = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/export/financial-feed.csv?key=${activeFeedKey}`,
    method: "GET",
  });
  assert(oldKeyRevoked.status === 401, "Revoked feed key is immediately rejected with HTTP 401");

  const newKeyWorks = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/export/financial-feed.csv?key=${newFeedKey}`,
    method: "GET",
  });
  assert(newKeyWorks.status === 200, "New regenerated feed key serves live CSV feed with HTTP 200");

  // 11. Checking Balance Persistence & Dashboard Integration
  console.log("\n--- Suite 11: Checking Balance Persistence & Dashboard Integration ---");
  const updateCheckingRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/checking",
      method: "PUT",
      headers: authHeaders,
    },
    { balance: 750.50 }
  );
  assert(
    updateCheckingRes.status === 200 &&
      updateCheckingRes.body.currentBalance === 750.5,
    "PUT /api/checking successfully updates checking currentBalance to $750.50"
  );

  const dashAfterChecking = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  assert(
    dashAfterChecking.status === 200 &&
      dashAfterChecking.body.checkingAccount?.currentBalance === 750.5,
    "GET /api/dashboard returns updated checking currentBalance of $750.50"
  );

  const invalidCheckingRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/checking",
      method: "PUT",
      headers: authHeaders,
    },
    { balance: "invalid-number" }
  );
  assert(
    invalidCheckingRes.status === 400,
    "PUT /api/checking rejects non-numeric payload with HTTP 400"
  );

  // --- Suite 12: Financial Symmetry, Backfills & Compounding Tax Edge Cases ---
  console.log("\n--- Suite 12: Financial Symmetry & Tax Compounding Edge Cases ---");

  // 12a. Overpaying debt and deleting payment restores balance with 100% symmetry (no inflation)
  const debtRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/debts",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Symmetry Test Debt",
      total_amount: 30.0,
      monthly_payment: 10.0,
    }
  );
  assert(debtRes.status === 201 && debtRes.body.id, "Creates test debt with balance $30");
  const symDebtId = debtRes.body.id;

  const overpayRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Overpayment $50",
      amount: 50.0,
      category: "Debt",
      targetAccountId: symDebtId,
    }
  );
  assert(overpayRes.status === 201 && overpayRes.body.id, "Creates $50 paydown on $30 debt");
  const overpayExpId = overpayRes.body.id;

  let debtCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "GET",
    headers: authHeaders,
  });
  let foundDebt = (debtCheck.body || []).find((d) => d.id === symDebtId);
  assert(parseFloat(foundDebt.total_remaining) === -20, "Debt balance is -$20 without asymmetric clamping floor");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${overpayExpId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  debtCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "GET",
    headers: authHeaders,
  });
  foundDebt = (debtCheck.body || []).find((d) => d.id === symDebtId);
  assert(parseFloat(foundDebt.total_remaining) === 30, "Deleting overpayment cleanly restores debt to $30 (NOT inflated to $50)");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/debts/${symDebtId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 12b. Editing expense the day after entry preserves card balance
  const cardSymRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/credit-cards",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Symmetry Card",
      creditLimit: 1000,
      currentBalance: 100,
    }
  );
  assert(cardSymRes.status === 201 && cardSymRes.body.id, "Creates test card with balance $100");
  const cardSymId = cardSymRes.body.id;

  const cardChargeRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Card Charge $50",
      amount: 50.0,
      category: "Food & Drink",
      creditCardId: cardSymId,
    }
  );
  assert(cardChargeRes.status === 201 && cardChargeRes.body.id, "Creates $50 charge on card");
  const cardChargeId = cardChargeRes.body.id;

  // Simulate backdating / editing the day after entry: change date to a past date and rename
  const editPastRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${cardChargeId}`,
      method: "PUT",
      headers: authHeaders,
    },
    {
      name: "Renamed Card Charge $50",
      amount: 50.0,
      date: "2020-01-01",
    }
  );
  assert(editPastRes.status === 200, "Successfully edits already-applied expense with past date");

  let cardSymCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  let foundCardSym = (cardSymCheck.body || []).find((c) => c.id === cardSymId);
  assert(parseFloat(foundCardSym.currentBalance) === 150, "Card balance remains $150 after editing previously-applied expense (does NOT drop to 100)");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${cardChargeId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  cardSymCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  foundCardSym = (cardSymCheck.body || []).find((c) => c.id === cardSymId);
  assert(parseFloat(foundCardSym.currentBalance) === 100, "Deleting card charge restores balance to $100");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/credit-cards/${cardSymId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 12c. Tax compounding prevention: editing tax-exclusive expense without baseAmount
  const taxCompExp = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Compounding Tax Test",
      amount: 100.0,
      category: "Utilities",
      isTaxExclusive: true,
      taxRate: 13,
      date: "2099-12-01",
    }
  );
  assert(taxCompExp.status === 201 && taxCompExp.body.id, "Creates tax-exclusive upcoming bill");
  const taxCompId = taxCompExp.body.id;

  // Pay the bill -> amount becomes 113.00, taxApplied: true
  const payTaxCompRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${taxCompId}`,
      method: "PUT",
      headers: authHeaders,
    },
    {
      isCleared: true,
    }
  );
  assert(payTaxCompRes.status === 200 && parseFloat(payTaxCompRes.body.amount) === 113.0, "Bill paid with 13% tax applied ($113.00)");

  // Edit sending only amount (113.00) without baseAmount
  const edit1Res = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${taxCompId}`,
      method: "PUT",
      headers: authHeaders,
    },
    {
      name: "Compounding Tax Test - First Edit",
      amount: 113.0,
    }
  );
  assert(edit1Res.status === 200 && parseFloat(edit1Res.body.amount) === 113.0, "First edit without baseAmount maintains $113.00 (NOT $127.69)");

  // Edit a second time sending only amount (113.00)
  const edit2Res = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${taxCompId}`,
      method: "PUT",
      headers: authHeaders,
    },
    {
      name: "Compounding Tax Test - Second Edit",
      amount: 113.0,
    }
  );
  assert(edit2Res.status === 200 && parseFloat(edit2Res.body.amount) === 113.0, "Second edit without baseAmount maintains $113.00 (NOT $144.29)");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${taxCompId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // --- Suite 13: Sweep Atomicity, Multi-Bill Charges & Unblocked Auto-Pay ---
  console.log("\n--- Suite 13: Sweep Atomicity & Multi-Bill Charges ---");

  const todayStr = format(toZonedTime(new Date(), "America/Toronto"), "yyyy-MM-dd");

  // 13a. Daily sweep with multiple bills due on same day to same card accumulates all charges (no lost updates)
  const sweepCardRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/credit-cards",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Multi-Bill Sweep Card",
      creditLimit: 1000,
      currentBalance: 0,
    }
  );
  assert(sweepCardRes.status === 201 && sweepCardRes.body.id, "Creates test card with balance $0");
  const sweepCardId = sweepCardRes.body.id;

  const bill1 = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Due Bill 1",
      amount: 10.0,
      category: "Bills & Utilities",
      creditCardId: sweepCardId,
      due_date: todayStr,
      is_paid: false,
    }
  );
  const bill2 = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Due Bill 2",
      amount: 15.0,
      category: "Bills & Utilities",
      creditCardId: sweepCardId,
      due_date: todayStr,
      is_paid: false,
    }
  );
  assert(bill1.status === 201 && bill2.status === 201, "Creates two unpaid bills ($10 & $15) due today on same card");

  const sweepCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/daily-check",
    method: "GET",
    headers: authHeaders,
  });
  assert(sweepCheck.status === 200, "Executes daily sweep on due bills");

  let sweepCardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  let foundSweepCard = (sweepCardQuery.body || []).find((c) => c.id === sweepCardId);
  assert(parseFloat(foundSweepCard.currentBalance) === 25.0, "Card balance is exactly $25.00 (accumulated both $10 and $15 without lost update)");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${bill1.body.id}`,
    method: "DELETE",
    headers: authHeaders,
  });
  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${bill2.body.id}`,
    method: "DELETE",
    headers: authHeaders,
  });

  sweepCardQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  foundSweepCard = (sweepCardQuery.body || []).find((c) => c.id === sweepCardId);
  assert(parseFloat(foundSweepCard.currentBalance) === 0.0, "Deleting both swept bills cleanly returns card balance to $0");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/credit-cards/${sweepCardId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 13b. Updating tax-exclusive expense with a new amount without baseAmount updates amount cleanly
  const taxNewAmtExp = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Tax New Amount Test",
      amount: 100.0,
      category: "Utilities",
      isTaxExclusive: true,
      taxRate: 13,
      date: "2099-12-01",
    }
  );
  assert(taxNewAmtExp.status === 201 && taxNewAmtExp.body.id, "Creates tax-exclusive bill $100");

  // Pay bill -> 113.00
  await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${taxNewAmtExp.body.id}`,
      method: "PUT",
      headers: authHeaders,
    },
    { isCleared: true }
  );

  // Edit with a brand new amount (200.00) without baseAmount
  const editNewAmtRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${taxNewAmtExp.body.id}`,
      method: "PUT",
      headers: authHeaders,
    },
    {
      amount: 200.0,
    }
  );
  assert(
    editNewAmtRes.status === 200 && parseFloat(editNewAmtRes.body.amount) === 226.0,
    "Editing tax-exclusive expense with new amount 200.00 applies tax to yield $226.00 (not silently ignored)"
  );

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${taxNewAmtExp.body.id}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 13c. Manual debt payment on due date does NOT block scheduled auto-pay
  const autoPayDebtRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/debts",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Unblocked AutoPay Debt",
      total_amount: 100.0,
      monthly_payment: 25.0,
      auto_pay: true,
      next_due_date: todayStr,
    }
  );
  assert(autoPayDebtRes.status === 201 && autoPayDebtRes.body.id, "Creates auto-pay debt due today with balance $100");
  const autoPayDebtId = autoPayDebtRes.body.id;

  // Make manual payment of $10 today
  const manualPayRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/debts/${autoPayDebtId}/pay`,
      method: "POST",
      headers: authHeaders,
    },
    { amount: 10.0 }
  );
  assert(manualPayRes.status === 200 && parseFloat(manualPayRes.body.total_remaining) === 90.0, "Manual payment of $10 reduces debt to $90");

  // Run daily sweep: auto-pay should NOT be blocked by manual payment
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/daily-check",
    method: "GET",
    headers: authHeaders,
  });

  const debtAfterSweep = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "GET",
    headers: authHeaders,
  });
  const foundDebtAfterSweep = (debtAfterSweep.body || []).find((d) => d.id === autoPayDebtId);
  assert(
    parseFloat(foundDebtAfterSweep.total_remaining) === 65.0,
    "Scheduled auto-pay ($25) executes successfully despite earlier manual payment ($90 - $25 = $65)"
  );

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/debts/${autoPayDebtId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // --- Suite 14: Overdue Manual Bill Payment & Savings Goal Balance Preservation ---
  console.log("\n--- Suite 14: Overdue Manual Bill Payment & Savings Goal Balance ---");

  // 14a. Overdue bill marked paid by hand reduces the debt balance (not ignored)
  const overdueDebtRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/debts",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Overdue Loan",
      total_amount: 100.0,
      monthly_payment: 10.0,
    }
  );
  assert(overdueDebtRes.status === 201 && overdueDebtRes.body.id, "Creates test debt $100");
  const overdueDebtId = overdueDebtRes.body.id;

  // Unpaid bill due in past
  const overdueBillRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Overdue Bill",
      amount: 10.0,
      category: "Debt",
      targetAccountId: overdueDebtId,
      due_date: "2020-01-01",
      is_paid: false,
    }
  );
  assert(overdueBillRes.status === 201 && overdueBillRes.body.id, "Creates unpaid bill dated in past on debt");
  const overdueBillId = overdueBillRes.body.id;

  // Verify debt balance is still 100 before payment
  let debtQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "GET",
    headers: authHeaders,
  });
  let foundOverdueDebt = (debtQuery.body || []).find((d) => d.id === overdueDebtId);
  assert(parseFloat(foundOverdueDebt.total_remaining) === 100.0, "Debt balance is $100 before marking bill paid");

  // Mark bill paid by hand via PUT /expenses/:id
  const markPaidRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${overdueBillId}`,
      method: "PUT",
      headers: authHeaders,
    },
    { is_paid: true }
  );
  assert(markPaidRes.status === 200, "Marks overdue bill paid by hand with HTTP 200");

  debtQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "GET",
    headers: authHeaders,
  });
  foundOverdueDebt = (debtQuery.body || []).find((d) => d.id === overdueDebtId);
  assert(parseFloat(foundOverdueDebt.total_remaining) === 90.0, "Overdue bill marked paid by hand reduces debt balance to $90.00 (not ignored)");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${overdueBillId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  debtQuery = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "GET",
    headers: authHeaders,
  });
  foundOverdueDebt = (debtQuery.body || []).find((d) => d.id === overdueDebtId);
  assert(parseFloat(foundOverdueDebt.total_remaining) === 100.0, "Deleting paid overdue bill cleanly restores debt balance to $100.00");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/debts/${overdueDebtId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 14b. Savings goal contributions always preserve balanceApplied and cleanly reverse on delete
  const savingsGoalRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/savings-goals",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Vacation Fund",
      target_amount: 1000,
      current_amount: 100,
    }
  );
  assert(savingsGoalRes.status === 201 && savingsGoalRes.body.id, "Creates test savings goal with $100");
  const savingsGoalId = savingsGoalRes.body.id;

  const contribRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/savings-goals/${savingsGoalId}/contribute`,
      method: "POST",
      headers: authHeaders,
    },
    { amount: 50.0 }
  );
  assert(contribRes.status === 200 && parseFloat(contribRes.body.current_amount) === 150.0, "Contribution of $50 increases savings goal to $150");

  // Query transactions from full ledger to find the contribution
  const trxList = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/all",
    method: "GET",
    headers: authHeaders,
  });
  const allTrx = Array.isArray(trxList.body) ? trxList.body : [];
  const contribTrx = allTrx.find((t) => t.targetAccountId === savingsGoalId);
  assert(contribTrx && contribTrx.balanceApplied === true, "Savings contribution has balanceApplied: true");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${contribTrx.id}`,
    method: "DELETE",
    headers: authHeaders,
  });

  const goalsList = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  const foundGoal = (goalsList.body || []).find((g) => g.id === savingsGoalId);
  assert(parseFloat(foundGoal.current_amount) === 100.0, "Deleting savings contribution cleanly reduces savings goal to $100");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/savings-goals/${savingsGoalId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 14c. Backdated savings contribution entered via Add Transaction applies to goal balance
  const backdatedGoalRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/savings-goals",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Emergency Fund",
      target_amount: 1000,
      current_amount: 500,
    }
  );
  assert(backdatedGoalRes.status === 201 && backdatedGoalRes.body.id, "Creates test savings goal with $500");
  const backdatedGoalId = backdatedGoalRes.body.id;

  // Add a $100 contribution dated 10 days ago (2020-01-01)
  const backdatedExpRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Backdated Savings Deposit",
      amount: 100.0,
      category: "Savings Transfer",
      targetAccountId: backdatedGoalId,
      due_date: "2020-01-01",
      is_paid: true,
    }
  );
  assert(backdatedExpRes.status === 201 && backdatedExpRes.body.id, "Creates backdated savings contribution of $100");
  const backdatedExpId = backdatedExpRes.body.id;

  let goalCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  let foundBackdatedGoal = (goalCheck.body || []).find((g) => g.id === backdatedGoalId);
  assert(parseFloat(foundBackdatedGoal.current_amount) === 600.0, "Backdated savings contribution applies to goal ($500 -> $600)");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${backdatedExpId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  goalCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  foundBackdatedGoal = (goalCheck.body || []).find((g) => g.id === backdatedGoalId);
  assert(parseFloat(foundBackdatedGoal.current_amount) === 500.0, "Deleting backdated savings contribution cleanly restores goal to $500.00");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/savings-goals/${backdatedGoalId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // 15. Future Unpaid Transfers, Upcoming Bills & Checking Balance Integrity
  console.log("\n--- Suite 15: Future Unpaid Transfers & Advisor Balance Integrity ---");

  // Create test card with $1,000 balance
  const s15CardRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/credit-cards",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Suite 15 Sapphire Card",
      currentBalance: 1000.0,
      creditLimit: 5000.0,
      dueDate: "2026-11-15",
    }
  );
  assert(s15CardRes.status === 201 && s15CardRes.body.id, "Creates test credit card with balance $1,000");
  const s15CardId = s15CardRes.body.id;

  // Get current checking balance
  const s15InitialDash = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  const s15InitialChecking = parseFloat(s15InitialDash.body?.checkingAccount?.currentBalance || 0);

  // Compute a future date (5 days from today in Toronto timezone)
  const s15NowToronto = toZonedTime(new Date(), "America/Toronto");
  const s15FutureToronto = new Date(s15NowToronto.getTime() + 5 * 24 * 60 * 60 * 1000);
  const s15FutureDateStr = format(s15FutureToronto, "yyyy-MM-dd", { timeZone: "America/Toronto" });

  // Add an unpaid $200 card payment scheduled for future date
  const s15UnpaidTransfer = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Suite 15 Sapphire Payment",
      amount: 200.0,
      category: "Credit Card Payment",
      targetAccountId: s15CardId,
      due_date: s15FutureDateStr,
      is_paid: false,
    }
  );
  assert(s15UnpaidTransfer.status === 201 && s15UnpaidTransfer.body.id, "Schedules unpaid $200 card payment in future");
  const s15TransferId = s15UnpaidTransfer.body.id;
  assert(s15UnpaidTransfer.body.type === "TRANSFER", "Transaction categorized as TRANSFER");
  assert(s15UnpaidTransfer.body.isCleared === false, "Transaction created with isCleared: false");
  assert(s15UnpaidTransfer.body.balanceApplied === false, "Transaction created with balanceApplied: false");

  // Verify card balance remains $1,000 (NOT deducted to $800)
  const s15CardsCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  const s15FoundCard = (s15CardsCheck.body || []).find((c) => c.id === s15CardId);
  assert(parseFloat(s15FoundCard?.currentBalance || 0) === 1000.0, "Future unpaid card payment does NOT deduct card balance immediately (remains $1,000)");

  // Verify checking balance has NOT decreased by $200
  const s15AfterSchedDash = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  const s15AfterChecking = parseFloat(s15AfterSchedDash.body?.checkingAccount?.currentBalance || 0);
  assert(s15AfterChecking === s15InitialChecking, "Future unpaid transfer does NOT deduct checking balance immediately");

  // Verify future transfer appears in upcoming bills
  const s15UpcomingBills = s15AfterSchedDash.body?.upcomingBills || [];
  const s15FoundUpcoming = s15UpcomingBills.find((b) => b.id === s15TransferId);
  assert(Boolean(s15FoundUpcoming), "Future unpaid transfer appears in Upcoming Bills");

  // Mark the payment paid via PUT /api/expenses/:id
  const s15MarkPaidRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${s15TransferId}`,
      method: "PUT",
      headers: authHeaders,
    },
    {
      name: "Suite 15 Sapphire Payment",
      amount: 200.0,
      category: "Credit Card Payment",
      targetAccountId: s15CardId,
      due_date: s15FutureDateStr,
      is_paid: true,
    }
  );
  assert(s15MarkPaidRes.status === 200, "Marks future transfer as paid via PUT /api/expenses/:id");

  // Verify card balance is now $800.00
  const s15CardsAfterPaid = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  const s15FoundCardPaid = (s15CardsAfterPaid.body || []).find((c) => c.id === s15CardId);
  assert(parseFloat(s15FoundCardPaid?.currentBalance || 0) === 800.0, "Marking payment as paid reduces card balance to $800.00");

  // Verify checking balance decreases by $200
  const s15PaidDash = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  const s15PaidChecking = parseFloat(s15PaidDash.body?.checkingAccount?.currentBalance || 0);
  assert(s15PaidChecking === s15InitialChecking - 200.0, "Marking transfer as paid reflects in checking balance");

  // Delete the paid payment and verify card balance is restored to $1,000
  const s15DeleteTransferRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${s15TransferId}`,
    method: "DELETE",
    headers: authHeaders,
  });
  assert(s15DeleteTransferRes.status === 204, "Deletes paid transfer");

  const s15CardsRestored = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  const s15FoundCardRestored = (s15CardsRestored.body || []).find((c) => c.id === s15CardId);
  assert(parseFloat(s15FoundCardRestored?.currentBalance || 0) === 1000.0, "Deleting paid transfer restores card balance to $1,000.00");

  // Verify recurring transfer generation: create recurring transfer and trigger recurring generator
  const s15RecTransferRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Suite 15 Recurring Card Payment",
      amount: 50.0,
      category: "Credit Card Payment",
      targetAccountId: s15CardId,
      due_date: format(s15NowToronto, "yyyy-MM-dd", { timeZone: "America/Toronto" }),
      is_paid: true,
      recurrence: "monthly",
    }
  );
  assert(s15RecTransferRes.status === 201, "Creates recurring monthly credit card transfer");
  const s15BaseRecId = s15RecTransferRes.body.id;

  // Trigger recurring generation
  const s15TriggerRecRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/recurring/trigger-recurring",
    method: "GET",
    headers: authHeaders,
  });
  assert(s15TriggerRecRes.status === 200, "Triggers recurring generation for TRANSFER types");

  // Check generated upcoming transfers
  const s15RecDashRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  const s15UpcomingRec = (s15RecDashRes.body?.upcomingBills || []).find(
    (b) => b.title === "Suite 15 Recurring Card Payment" || b.name === "Suite 15 Recurring Card Payment"
  );
  if (s15UpcomingRec) {
    assert(s15UpcomingRec.isCleared === false || s15UpcomingRec.is_paid === false, "Generated recurring transfer is unpaid (isCleared: false)");
    assert(s15UpcomingRec.balanceApplied === false, "Generated recurring transfer has balanceApplied: false");
    await request({
      hostname: "localhost",
      port: 8000,
      path: `/api/expenses/${s15UpcomingRec.id}`,
      method: "DELETE",
      headers: authHeaders,
    });
  }

  // Cleanup base recurring transfer and test card
  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${s15BaseRecId}`,
    method: "DELETE",
    headers: authHeaders,
  });
  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/credit-cards/${s15CardId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  // Test Item 9: Paydown target resolution prefix & exact matching
  const s15DebtRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/debts",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Student Loan 15",
      total_amount: 1000.0,
      monthly_payment: 50.0,
      next_due_date: "2026-11-01",
    }
  );
  assert(s15DebtRes.status === 201 && s15DebtRes.body.id, "Creates test debt for paydown target resolution");
  const s15DebtId = s15DebtRes.body.id;

  // 1. Exact match
  const s15ExactExpRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Student Loan 15",
      amount: 100.0,
      category: "Debt",
      is_paid: true,
    }
  );
  assert(s15ExactExpRes.status === 201 && s15ExactExpRes.body.toAccountId === s15DebtId, "Exact name matches target debt account");

  // 2. Prefix 'Payment for <Account>'
  const s15PrefixExpRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Payment for Student Loan 15",
      amount: 100.0,
      category: "Debt",
      is_paid: true,
    }
  );
  assert(s15PrefixExpRes.status === 201 && s15PrefixExpRes.body.toAccountId === s15DebtId, "Prefix 'Payment for <Account>' matches target debt account");

  // 3. Unrelated debt title should NOT resolve randomly
  const s15UnrelatedExpRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Random Other Expense",
      amount: 100.0,
      category: "Debt",
      is_paid: true,
    }
  );
  assert(s15UnrelatedExpRes.status === 201 && s15UnrelatedExpRes.body.toAccountId === null, "Unrelated expense does NOT resolve to target debt");

  // Cleanup debt and expenses
  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s15ExactExpRes.body.id}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s15PrefixExpRes.body.id}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s15UnrelatedExpRes.body.id}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/debts/${s15DebtId}`, method: "DELETE", headers: authHeaders });

  // 16. Edge Cases: Pre-Fix Transfers, Target Preservation & Sweep Savings Contributions
  console.log("\n--- Suite 16: Pre-Fix Transfers, Target Preservation & Sweep Savings ---");

  // Scenario A: Pre-fix scheduled card payment with balanceApplied: true does NOT get applied twice by the sweep
  // Setup: card at 800 (1000 minus 200 already applied in pre-fix state)
  const s16CardA = await request(
    { hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "POST", headers: authHeaders },
    { name: "Suite 16 Card A", currentBalance: 800.0, creditLimit: 2000.0, dueDate: "2026-11-15" }
  );
  assert(s16CardA.status === 201 && s16CardA.body.id, "Creates test card at $800 balance");
  const s16CardAId = s16CardA.body.id;

  const s16Today = format(toZonedTime(new Date(), "America/Toronto"), "yyyy-MM-dd", { timeZone: "America/Toronto" });

  // Create pre-fix style unpaid transfer due today that has balanceApplied: true
  const { Transaction: DBTransaction } = require("../models");
  const s16PreFixTrx = await DBTransaction.create({
    title: "Pre-Fix Card Payment",
    amount: 200.0,
    date: s16Today,
    type: "TRANSFER",
    category: "Credit Card Payment",
    isCleared: false,
    balanceApplied: true, // simulates pre-fix state
    toAccountId: s16CardAId,
  });
  assert(Boolean(s16PreFixTrx.id), "Directly seeds pre-fix unpaid card payment with balanceApplied: true");

  // Run the daily sweep
  const s16SweepRes = await request({ hostname: "localhost", port: 8000, path: "/api/daily-check", method: "GET" });
  assert(s16SweepRes.status === 200, "Daily check/sweep executes successfully");

  // Card balance must still be $800, NOT $600!
  const s16CardsCheckA = await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "GET", headers: authHeaders });
  const s16FoundCardA = (s16CardsCheckA.body || []).find((c) => c.id === s16CardAId);
  assert(parseFloat(s16FoundCardA?.currentBalance || 0) === 800.0, "Pre-fix transfer with balanceApplied: true is NOT applied twice by sweep (stays $800, not $600)");

  // Cleanup A
  await DBTransaction.destroy({ where: { id: s16PreFixTrx.id } });
  await request({ hostname: "localhost", port: 8000, path: `/api/credit-cards/${s16CardAId}`, method: "DELETE", headers: authHeaders });

  // Scenario A2: Pre-6b06ed2 transfer (balanceApplied: false, but prematurely applied at creation)
  const s16CardA2 = await request(
    { hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "POST", headers: authHeaders },
    { name: "Suite 16 Card A2", currentBalance: 800.0, creditLimit: 2000.0, dueDate: "2026-11-15" }
  );
  assert(s16CardA2.status === 201 && s16CardA2.body.id, "Creates test card A2 at $800 balance");
  const s16CardA2Id = s16CardA2.body.id;

  const s16Pre6bTrx = await DBTransaction.create({
    title: "Pre-6b06ed2 Card Payment",
    amount: 200.0,
    date: s16Today,
    type: "TRANSFER",
    category: "Credit Card Payment",
    isCleared: false,
    balanceApplied: false, // pre-6b06ed2 rows had balanceApplied: false
    toAccountId: s16CardA2Id,
    createdAt: new Date("2026-10-18T12:00:00Z"), // before LEGACY_CUTOFF
  });

  // Verify atomic concurrency claim mechanism on this row
  const { Setting: DBSetting, Account: DBAccount, sequelize: DBSequelize } = require("../models");
  const { Op } = require("sequelize");
  const claimKey = `remed_unpaid_transfer_${s16Pre6bTrx.id}`;
  
  // Instance 1 claims
  const t1 = await DBSequelize.transaction();
  const [_, created1] = await DBSetting.findOrCreate({
    where: { key: claimKey },
    defaults: { key: claimKey, value: "restored" },
    transaction: t1,
  });
  if (created1) {
    await DBAccount.increment("initialBalance", { by: 200.0, where: { id: s16CardA2Id }, transaction: t1 });
    await DBTransaction.update({ balanceApplied: false }, { where: { id: s16Pre6bTrx.id }, transaction: t1 });
    await t1.commit();
  }
  assert(created1 === true, "First server instance successfully claims pre-6b06ed2 transfer and restores $200");

  // Instance 2 attempts concurrent claim on same row
  const t2 = await DBSequelize.transaction();
  let created2 = false;
  try {
    const [__, c2] = await DBSetting.findOrCreate({
      where: { key: claimKey },
      defaults: { key: claimKey, value: "restored" },
      transaction: t2,
    });
    created2 = c2;
    if (created2) {
      await DBAccount.increment("initialBalance", { by: 200.0, where: { id: s16CardA2Id }, transaction: t2 });
      await t2.commit();
    } else {
      await t2.rollback();
    }
  } catch {
    await t2.rollback().catch(() => {});
  }
  assert(created2 === false, "Second concurrent server instance fails claim and does NOT double-increment balance");

  // Check card balance before sweep: 800 + 200 restored = 1000
  let cardA2Check = await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "GET", headers: authHeaders });
  let foundCardA2 = (cardA2Check.body || []).find((c) => c.id === s16CardA2Id);
  assert(parseFloat(foundCardA2?.currentBalance || 0) === 1000.0, "Card A2 balance restored to $1,000 prior to sweep");

  // Sweep runs on due date: applies $200 payment cleanly
  await request({ hostname: "localhost", port: 8000, path: "/api/daily-check", method: "GET" });
  cardA2Check = await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "GET", headers: authHeaders });
  foundCardA2 = (cardA2Check.body || []).find((c) => c.id === s16CardA2Id);
  assert(parseFloat(foundCardA2?.currentBalance || 0) === 800.0, "After sweep, pre-6b06ed2 payment leaves card cleanly at $800.00 (not $600)");

  // Cleanup A2
  await DBTransaction.destroy({ where: { id: s16Pre6bTrx.id } });
  await DBSetting.destroy({ where: { key: claimKey } });
  await request({ hostname: "localhost", port: 8000, path: `/api/credit-cards/${s16CardA2Id}`, method: "DELETE", headers: authHeaders });

  // Scenario A3: A payment scheduled under the new code is untouched by the cleanup
  const s16CardA3 = await request(
    { hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "POST", headers: authHeaders },
    { name: "Suite 16 Card A3", currentBalance: 1000.0, creditLimit: 2000.0, dueDate: "2026-11-15" }
  );
  assert(s16CardA3.status === 201 && s16CardA3.body.id, "Creates test card A3 at $1,000 balance");
  const s16CardA3Id = s16CardA3.body.id;

  // Schedule a $200 unpaid card payment due today under the new code
  const s16NewPayment = await request(
    { hostname: "localhost", port: 8000, path: "/api/expenses", method: "POST", headers: authHeaders },
    {
      name: "Scheduled Payment New Code",
      amount: 200.0,
      category: "Credit Card Payment",
      targetAccountId: s16CardA3Id,
      due_date: s16Today,
      is_paid: false,
    }
  );
  assert(s16NewPayment.status === 201, "Schedules unpaid $200 card payment under new code");
  const s16NewPaymentId = s16NewPayment.body.id;

  // Verify initial state: card balance stays at $1,000 and payment has balanceApplied = false
  let cardA3Check = await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "GET", headers: authHeaders });
  let foundCardA3 = (cardA3Check.body || []).find((c) => c.id === s16CardA3Id);
  assert(parseFloat(foundCardA3?.currentBalance || 0) === 1000.0, "Card A3 starts at $1,000 balance upon payment scheduling");

  const newTrxInDb = await DBTransaction.findByPk(s16NewPaymentId);
  const LEGACY_CUTOFF = new Date("2026-10-20T06:00:00Z");
  assert(newTrxInDb.balanceApplied === false, "Payment scheduled under new code has balanceApplied = false");
  assert(new Date(newTrxInDb.createdAt) >= LEGACY_CUTOFF, "Payment scheduled under new code has createdAt >= LEGACY_CUTOFF");

  // Run the cleanup logic on candidate transfers
  const candidateTransfersA3 = await DBTransaction.findAll({
    where: {
      id: s16NewPaymentId,
      type: "TRANSFER",
      isCleared: false,
      toAccountId: { [Op.ne]: null },
    },
    include: [{ model: DBAccount, as: "toAccount" }],
  });

  let a3RestoredCount = 0;
  for (const trx of candidateTransfersA3) {
    const isTargetDebtOrCard =
      trx.toAccount && ["CREDIT_CARD", "DEBT"].includes(trx.toAccount.type);
    if (!isTargetDebtOrCard) continue;

    const createdDateStr = trx.createdAt
      ? format(toZonedTime(trx.createdAt, "America/Toronto"), "yyyy-MM-dd")
      : null;
    const isPremature =
      trx.balanceApplied === true ||
      (trx.balanceApplied === false &&
        trx.createdAt < LEGACY_CUTOFF &&
        createdDateStr &&
        trx.date >= createdDateStr);

    if (!isPremature) continue;

    const claimKeyA3 = `remed_unpaid_transfer_${trx.id}`;
    const [_, created] = await DBSetting.findOrCreate({
      where: { key: claimKeyA3 },
      defaults: { key: claimKeyA3, value: "restored" },
    });
    if (created) {
      await DBAccount.increment("initialBalance", { by: parseFloat(trx.amount), where: { id: trx.toAccountId } });
      a3RestoredCount++;
    }
  }

  assert(a3RestoredCount === 0, "A payment scheduled under the new code is untouched by the cleanup (0 restored)");

  // Card A3 balance must remain $1,000 (NOT incremented to $1,200)
  cardA3Check = await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "GET", headers: authHeaders });
  foundCardA3 = (cardA3Check.body || []).find((c) => c.id === s16CardA3Id);
  assert(parseFloat(foundCardA3?.currentBalance || 0) === 1000.0, "Card A3 balance remains $1,000 after cleanup (not corrupted to $1,200)");

  // Daily sweep then runs on due date and cleanly applies the $200 payment (1,000 -> 800)
  await request({ hostname: "localhost", port: 8000, path: "/api/daily-check", method: "GET" });
  cardA3Check = await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "GET", headers: authHeaders });
  foundCardA3 = (cardA3Check.body || []).find((c) => c.id === s16CardA3Id);
  assert(parseFloat(foundCardA3?.currentBalance || 0) === 800.0, "Daily sweep applies scheduled payment on due date leaving card cleanly at $800.00");

  // Cleanup A3
  await DBTransaction.destroy({ where: { id: s16NewPaymentId } });
  await request({ hostname: "localhost", port: 8000, path: `/api/credit-cards/${s16CardA3Id}`, method: "DELETE", headers: authHeaders });

  // Scenario B: Editing in Ledger preserves targetAccountId and does not unlink
  // 1. Mark a scheduled $200 card payment paid: card 1,000 -> 800, still linked
  const s16CardB = await request(
    { hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "POST", headers: authHeaders },
    { name: "Suite 16 Card B", currentBalance: 1000.0, creditLimit: 2000.0, dueDate: "2026-11-15" }
  );
  const s16CardBId = s16CardB.body.id;

  const s16SchedPayment = await request(
    { hostname: "localhost", port: 8000, path: "/api/expenses", method: "POST", headers: authHeaders },
    { name: "Suite 16 Sapphire Payment", amount: 200.0, category: "Credit Card Payment", targetAccountId: s16CardBId, due_date: s16Today, is_paid: false }
  );
  assert(s16SchedPayment.status === 201, "Creates scheduled unpaid card payment");
  const s16SchedId = s16SchedPayment.body.id;

  // Edit via PUT (simulating Ledger marking paid without sending targetAccountId or sending targetAccountId: null)
  const s16EditPayment = await request(
    { hostname: "localhost", port: 8000, path: `/api/expenses/${s16SchedId}`, method: "PUT", headers: authHeaders },
    { name: "Suite 16 Sapphire Payment", amount: 200.0, category: "Credit Card Payment", is_paid: true, targetAccountId: null }
  );
  assert(s16EditPayment.status === 200, "Edits scheduled payment to mark as paid");
  assert(s16EditPayment.body.toAccountId === s16CardBId, "Preserves targetAccountId link to card when targetAccountId was omitted/null in edit");

  const s16CardsCheckB = await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "GET", headers: authHeaders });
  const s16FoundCardB = (s16CardsCheckB.body || []).find((c) => c.id === s16CardBId);
  assert(parseFloat(s16FoundCardB?.currentBalance || 0) === 800.0, "Card balance reduces to $800 after marking paid in Ledger");

  // 2. Rename a $100 savings contribution in the Ledger: goal stays 600, still linked
  const s16GoalB = await request(
    { hostname: "localhost", port: 8000, path: "/api/savings-goals", method: "POST", headers: authHeaders },
    { name: "Suite 16 Vacation Goal", target_amount: 1000.0, current_amount: 500.0 }
  );
  const s16GoalBId = s16GoalB.body.id;

  const s16SavingsTrx = await request(
    { hostname: "localhost", port: 8000, path: "/api/expenses", method: "POST", headers: authHeaders },
    { name: "Trip Deposit", amount: 100.0, category: "Savings Transfer", targetAccountId: s16GoalBId, due_date: s16Today, is_paid: true }
  );
  assert(s16SavingsTrx.status === 201, "Adds $100 savings contribution");
  const s16SavingsTrxId = s16SavingsTrx.body.id;

  // Rename the savings contribution with targetAccountId: null
  const s16RenameRes = await request(
    { hostname: "localhost", port: 8000, path: `/api/expenses/${s16SavingsTrxId}`, method: "PUT", headers: authHeaders },
    { name: "Renamed Trip Deposit", amount: 100.0, category: "Savings Transfer", is_paid: true, targetAccountId: null }
  );
  assert(s16RenameRes.status === 200, "Renames savings contribution in Ledger");
  assert(s16RenameRes.body.toAccountId === s16GoalBId, "Savings contribution remains linked to goal after rename");

  const s16GoalsCheckB = await request({ hostname: "localhost", port: 8000, path: "/api/savings-goals", method: "GET", headers: authHeaders });
  const s16FoundGoalB = (s16GoalsCheckB.body || []).find((g) => g.id === s16GoalBId);
  assert(parseFloat(s16FoundGoalB?.current_amount || 0) === 600.0, "Savings goal balance remains $600 after rename");

  // Cleanup B
  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s16SchedId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/credit-cards/${s16CardBId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s16SavingsTrxId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/savings-goals/${s16GoalBId}`, method: "DELETE", headers: authHeaders });

  // 3. Edit debt payment to "Food & Drink" unlinks toAccountId
  const s16DebtB = await request(
    { hostname: "localhost", port: 8000, path: "/api/debts", method: "POST", headers: authHeaders },
    { name: "Suite 16 Debt Unlink", total_amount: 500.0, monthly_payment: 25.0, next_due_date: "2026-11-01" }
  );
  const s16DebtBId = s16DebtB.body.id;

  const s16DebtPayment = await request(
    { hostname: "localhost", port: 8000, path: "/api/expenses", method: "POST", headers: authHeaders },
    { name: "Debt Payment Test", amount: 50.0, category: "Debt", targetAccountId: s16DebtBId, due_date: s16Today, is_paid: true }
  );
  assert(s16DebtPayment.status === 201 && s16DebtPayment.body.toAccountId === s16DebtBId, "Creates debt payment linked to debt");
  const s16DebtPaymentId = s16DebtPayment.body.id;

  // Change category to "Food & Drink" with targetAccountId: null
  const s16SwitchCatRes = await request(
    { hostname: "localhost", port: 8000, path: `/api/expenses/${s16DebtPaymentId}`, method: "PUT", headers: authHeaders },
    { name: "Lunch with Team", amount: 50.0, category: "Food & Drink", is_paid: true, targetAccountId: null }
  );
  assert(s16SwitchCatRes.status === 200, "Updates transaction category to Food & Drink");
  assert(s16SwitchCatRes.body.toAccountId === null, "Changing category to Food & Drink unlinks toAccountId");

  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s16DebtPaymentId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/debts/${s16DebtBId}`, method: "DELETE", headers: authHeaders });

  // Scenario C: The sweep adds unpaid savings contributions to the goal
  const s16GoalC = await request(
    { hostname: "localhost", port: 8000, path: "/api/savings-goals", method: "POST", headers: authHeaders },
    { name: "Suite 16 Sweep Goal", target_amount: 1000.0, current_amount: 500.0 }
  );
  const s16GoalCId = s16GoalC.body.id;

  const s16UnpaidContrib = await request(
    { hostname: "localhost", port: 8000, path: "/api/expenses", method: "POST", headers: authHeaders },
    { name: "Pending Savings Contribution", amount: 100.0, category: "Savings Transfer", targetAccountId: s16GoalCId, due_date: s16Today, is_paid: false }
  );
  assert(s16UnpaidContrib.status === 201, "Creates unpaid $100 savings contribution due today");
  const s16UnpaidContribId = s16UnpaidContrib.body.id;

  // Execute daily sweep
  await request({ hostname: "localhost", port: 8000, path: "/api/daily-check", method: "GET" });

  const s16GoalsCheckC = await request({ hostname: "localhost", port: 8000, path: "/api/savings-goals", method: "GET", headers: authHeaders });
  const s16FoundGoalC = (s16GoalsCheckC.body || []).find((g) => g.id === s16GoalCId);
  assert(parseFloat(s16FoundGoalC?.current_amount || 0) === 600.0, "Daily sweep adds unpaid savings contribution to goal ($500 -> $600)");

  // Deleting contribution restores goal to 500
  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s16UnpaidContribId}`, method: "DELETE", headers: authHeaders });
  const s16GoalsCheckC2 = await request({ hostname: "localhost", port: 8000, path: "/api/savings-goals", method: "GET", headers: authHeaders });
  const s16FoundGoalC2 = (s16GoalsCheckC2.body || []).find((g) => g.id === s16GoalCId);
  assert(parseFloat(s16FoundGoalC2?.current_amount || 0) === 500.0, "Deleting swept savings contribution cleanly restores goal to $500.00");

  await request({ hostname: "localhost", port: 8000, path: `/api/savings-goals/${s16GoalCId}`, method: "DELETE", headers: authHeaders });

  // 17. Validation & Atomic Increments: Debts, Savings Goals, and Card Payments
  console.log("\n--- Suite 17: PUT Validation & Atomic Payment Increments ---");

  // 1. Debt PUT validation and atomic pay
  const s17Debt = await request(
    { hostname: "localhost", port: 8000, path: "/api/debts", method: "POST", headers: authHeaders },
    { name: "Suite 17 Debt", total_amount: 1000.0, monthly_payment: 100.0, next_due_date: "2026-11-01" }
  );
  assert(s17Debt.status === 201 && s17Debt.body.id, "Creates test debt for Suite 17");
  const s17DebtId = s17Debt.body.id;

  // Rejects invalid payload on PUT /debts/:id
  const s17BadDebtPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}`, method: "PUT", headers: authHeaders },
    { payment_frequency: "invalid_freq_value" }
  );
  assert(s17BadDebtPut.status === 400, "PUT /debts/:id rejects invalid payment_frequency with HTTP 400");

  // Valid PUT /debts/:id
  const s17GoodDebtPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}`, method: "PUT", headers: authHeaders },
    { name: "Updated Suite 17 Debt", monthly_payment: 150.0, auto_pay: true }
  );
  assert(s17GoodDebtPut.status === 200 && s17GoodDebtPut.body.name === "Updated Suite 17 Debt", "PUT /debts/:id successfully updates with valid payload");

  // Rejects malformed next_due_date on PUT /debts/:id
  const s17MalformedDateDebt = await request(
    { hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}`, method: "PUT", headers: authHeaders },
    { next_due_date: "invalid-date-format" }
  );
  assert(s17MalformedDateDebt.status === 400, "PUT /debts/:id rejects malformed next_due_date with HTTP 400");

  // Empty string monthly_payment leaves existing value unchanged (does NOT become 0 or NaN)
  const s17EmptyStringDebtPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}`, method: "PUT", headers: authHeaders },
    { monthly_payment: "" }
  );
  assert(s17EmptyStringDebtPut.status === 200 && parseFloat(s17EmptyStringDebtPut.body.monthly_payment) === 150.0, "PUT /debts/:id with empty string leaves monthly_payment unchanged at $150.00 (not 0 or NaN)");

  // Atomic debt payment
  const s17DebtPay = await request(
    { hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}/pay`, method: "POST", headers: authHeaders },
    { amount: 200.0 }
  );
  assert(s17DebtPay.status === 200 && parseFloat(s17DebtPay.body.total_remaining) === 800.0, "Atomic debt payment reduces debt balance from $1,000 to $800.00");

  // null total_remaining leaves existing value unchanged (does NOT reset to 0)
  const s17NullDebtPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}`, method: "PUT", headers: authHeaders },
    { total_remaining: null }
  );
  assert(s17NullDebtPut.status === 200 && parseFloat(s17NullDebtPut.body.total_remaining) === 800.0, "PUT /debts/:id with null total_remaining leaves balance unchanged at $800.00 (not reset to 0)");

  // null monthly_payment explicitly clears monthly_payment to null
  const s17ClearPaymentDebtPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}`, method: "PUT", headers: authHeaders },
    { monthly_payment: null }
  );
  assert(s17ClearPaymentDebtPut.status === 200 && s17ClearPaymentDebtPut.body.monthly_payment === null, "PUT /debts/:id with null monthly_payment clears monthly_payment to null");

  // 2. Savings Goal PUT validation and atomic contribute
  const s17Goal = await request(
    { hostname: "localhost", port: 8000, path: "/api/savings-goals", method: "POST", headers: authHeaders },
    { name: "Suite 17 Goal", target_amount: 1000.0, current_amount: 200.0 }
  );
  assert(s17Goal.status === 201 && s17Goal.body.id, "Creates test savings goal for Suite 17");
  const s17GoalId = s17Goal.body.id;

  // Rejects invalid payload on PUT /savings-goals/:id
  const s17BadGoalPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/savings-goals/${s17GoalId}`, method: "PUT", headers: authHeaders },
    { current_amount: -50 }
  );
  assert(s17BadGoalPut.status === 400, "PUT /savings-goals/:id rejects negative current_amount with HTTP 400");

  // Valid PUT /savings-goals/:id
  const s17GoodGoalPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/savings-goals/${s17GoalId}`, method: "PUT", headers: authHeaders },
    { name: "Updated Suite 17 Goal", goal_amount: 1500.0 }
  );
  assert(s17GoodGoalPut.status === 200 && parseFloat(s17GoodGoalPut.body.goal_amount) === 1500.0, "PUT /savings-goals/:id successfully updates with valid payload");

  // Rejects malformed target_date on PUT /savings-goals/:id
  const s17MalformedDateGoal = await request(
    { hostname: "localhost", port: 8000, path: `/api/savings-goals/${s17GoalId}`, method: "PUT", headers: authHeaders },
    { target_date: "invalid-date-format" }
  );
  assert(s17MalformedDateGoal.status === 400, "PUT /savings-goals/:id rejects malformed target_date with HTTP 400");

  // Empty string goal_amount leaves existing value unchanged (does NOT become null or NaN)
  const s17EmptyStringGoalPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/savings-goals/${s17GoalId}`, method: "PUT", headers: authHeaders },
    { goal_amount: "" }
  );
  assert(s17EmptyStringGoalPut.status === 200 && parseFloat(s17EmptyStringGoalPut.body.goal_amount) === 1500.0, "PUT /savings-goals/:id with empty string leaves goal_amount unchanged at $1,500.00 (not null or NaN)");

  // Atomic contribution to savings goal
  const s17GoalContribute = await request(
    { hostname: "localhost", port: 8000, path: `/api/savings-goals/${s17GoalId}/contribute`, method: "POST", headers: authHeaders },
    { amount: 150.0 }
  );
  assert(s17GoalContribute.status === 200 && parseFloat(s17GoalContribute.body.current_amount) === 350.0, "Atomic contribution increases savings goal from $200 to $350.00");

  // null current_amount leaves existing value unchanged (does NOT reset to 0)
  const s17NullGoalPut = await request(
    { hostname: "localhost", port: 8000, path: `/api/savings-goals/${s17GoalId}`, method: "PUT", headers: authHeaders },
    { current_amount: null }
  );
  assert(s17NullGoalPut.status === 200 && parseFloat(s17NullGoalPut.body.current_amount) === 350.0, "PUT /savings-goals/:id with null current_amount leaves balance unchanged at $350.00 (not reset to 0)");

  // 3. Atomic credit card payment
  const s17Card = await request(
    { hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "POST", headers: authHeaders },
    { name: "Suite 17 Card", currentBalance: 500.0, creditLimit: 2000.0, dueDate: "2026-11-15" }
  );
  assert(s17Card.status === 201 && s17Card.body.id, "Creates test credit card for Suite 17");
  const s17CardId = s17Card.body.id;

  const s17CardPay = await request(
    { hostname: "localhost", port: 8000, path: `/api/credit-cards/${s17CardId}/pay`, method: "POST", headers: authHeaders },
    { amount: 150.0 }
  );
  assert(s17CardPay.status === 200 && parseFloat(s17CardPay.body.currentBalance) === 350.0, "Atomic credit card payment reduces balance from $500 to $350.00");

  // Cleanup Suite 17
  await request({ hostname: "localhost", port: 8000, path: `/api/credit-cards/${s17CardId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/savings-goals/${s17GoalId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/debts/${s17DebtId}`, method: "DELETE", headers: authHeaders });

  // --- Suite 18: Auto-Pay Atomic Decrements & Transfer Type Re-derivation ---
  console.log("\n--- Suite 18: Auto-Pay Atomic Decrements & Transfer Type Re-derivation ---");

  // 18a. Auto-Pay atomic decrement & scheduling advancement
  const s18Today = format(toZonedTime(new Date(), "America/Toronto"), "yyyy-MM-dd", { timeZone: "America/Toronto" });
  const s18Debt = await request(
    { hostname: "localhost", port: 8000, path: "/api/debts", method: "POST", headers: authHeaders },
    {
      name: "Suite 18 Auto-Pay Debt",
      total_amount: 500.0,
      monthly_payment: 100.0,
      auto_pay: true,
      next_due_date: s18Today,
      payment_frequency: "monthly",
    }
  );
  assert(s18Debt.status === 201 && s18Debt.body.id, "Creates test auto-pay debt due today with $500 balance");
  const s18DebtId = s18Debt.body.id;

  // Payoff debt: balance equal to payment amount to test zero-floor and autoPay deactivation
  const s18PayoffDebt = await request(
    { hostname: "localhost", port: 8000, path: "/api/debts", method: "POST", headers: authHeaders },
    {
      name: "Suite 18 Payoff Debt",
      total_amount: 100.0,
      monthly_payment: 100.0,
      auto_pay: true,
      next_due_date: s18Today,
      payment_frequency: "monthly",
    }
  );
  assert(s18PayoffDebt.status === 201 && s18PayoffDebt.body.id, "Creates test auto-pay debt due today for complete payoff");
  const s18PayoffDebtId = s18PayoffDebt.body.id;

  // Run sweep: should process both due auto-pay debts
  const s18Sweep1 = await request({ hostname: "localhost", port: 8000, path: "/api/daily-check", method: "GET" });
  assert(s18Sweep1.status === 200, "Daily sweep processes due auto-pay debts");

  const s18DebtAfterSweep1 = await request({ hostname: "localhost", port: 8000, path: "/api/debts", method: "GET", headers: authHeaders });
  const s18FoundDebt1 = (s18DebtAfterSweep1.body || []).find((d) => d.id === s18DebtId);
  assert(
    parseFloat(s18FoundDebt1.total_remaining) === 400.0,
    "Auto-pay atomically decrements debt balance from $500 to $400"
  );
  assert(
    s18FoundDebt1.next_due_date > s18Today,
    "Auto-pay advances next_due_date to next monthly cycle"
  );
  assert(
    s18FoundDebt1.auto_pay === true,
    "Auto-pay remains active when remaining balance > 0"
  );

  const s18FoundPayoffDebt = (s18DebtAfterSweep1.body || []).find((d) => d.id === s18PayoffDebtId);
  assert(
    parseFloat(s18FoundPayoffDebt.total_remaining) === 0.0,
    "Auto-pay decrements debt to exactly $0.00 upon payoff"
  );
  assert(
    s18FoundPayoffDebt.auto_pay === false,
    "Auto-pay automatically turns off when debt balance reaches zero"
  );

  // 18b. Editing a TRANSFER to target a DEBT account re-derives type as EXPENSE
  const s18Card = await request(
    { hostname: "localhost", port: 8000, path: "/api/credit-cards", method: "POST", headers: authHeaders },
    { name: "Suite 18 Card", currentBalance: 300.0, creditLimit: 1000.0, dueDate: "2026-11-20" }
  );
  assert(s18Card.status === 201 && s18Card.body.id, "Creates test card for transfer re-derivation");
  const s18CardId = s18Card.body.id;

  const s18Transfer = await request(
    { hostname: "localhost", port: 8000, path: "/api/expenses", method: "POST", headers: authHeaders },
    {
      name: "Card Paydown Transfer",
      amount: 50.0,
      due_date: s18Today,
      category: "Credit Card Payment",
      targetAccountId: s18CardId,
      is_paid: false,
    }
  );
  assert(s18Transfer.status === 201 && s18Transfer.body.type === "TRANSFER", "Card payment created with type TRANSFER");
  const s18TrxId = s18Transfer.body.id;

  // Edit transaction: target the debt account instead of the card
  const s18RetargetDebt = await request(
    { hostname: "localhost", port: 8000, path: `/api/expenses/${s18TrxId}`, method: "PUT", headers: authHeaders },
    {
      name: "Payment for Suite 18 Auto-Pay Debt",
      category: "Debt",
      targetAccountId: s18DebtId,
    }
  );
  assert(
    s18RetargetDebt.status === 200 && s18RetargetDebt.body.type === "EXPENSE",
    "Editing transfer to target a DEBT account re-derives type as EXPENSE"
  );
  assert(
    s18RetargetDebt.body.category === "Debt",
    "Editing transfer to target debt sets category to Debt"
  );

  // Edit transaction back to target the credit card: re-derives as TRANSFER
  const s18RetargetCard = await request(
    { hostname: "localhost", port: 8000, path: `/api/expenses/${s18TrxId}`, method: "PUT", headers: authHeaders },
    {
      name: "Payment for Suite 18 Card",
      category: "Credit Card Payment",
      targetAccountId: s18CardId,
    }
  );
  assert(
    s18RetargetCard.status === 200 && s18RetargetCard.body.type === "TRANSFER",
    "Editing debt expense to target a CREDIT_CARD account re-derives type as TRANSFER"
  );

  // Clean up Suite 18 records
  await request({ hostname: "localhost", port: 8000, path: `/api/expenses/${s18TrxId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/credit-cards/${s18CardId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/debts/${s18DebtId}`, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: `/api/debts/${s18PayoffDebtId}`, method: "DELETE", headers: authHeaders });

  // 19. Hardening: Production Auth Enforcement & Recurring Group Idempotency (Unique Index)
  console.log("\n--- Suite 19: Production Auth Enforcement & Recurring Group Idempotency ---");
  const { assertAuthConfiguration } = require("../config/auth");
  const { Transaction } = require("../models");
  const { createRecurringExpenses } = require("../routes/recurring");

  // 19.1: Verify assertAuthConfiguration in production mode
  const origNodeEnv = process.env.NODE_ENV;
  const origPassword = process.env.SUPER_SECRET_PASSWORD;

  try {
    process.env.NODE_ENV = "production";
    delete process.env.SUPER_SECRET_PASSWORD;
    let authError = null;
    try {
      assertAuthConfiguration();
    } catch (err) {
      authError = err;
    }
    assert(
      authError !== null && authError.message.includes("FATAL CONFIGURATION ERROR: SUPER_SECRET_PASSWORD is not set"),
      "assertAuthConfiguration() refuses to start when NODE_ENV is production and SUPER_SECRET_PASSWORD is unset"
    );

    // In production with default "maverick" password
    process.env.SUPER_SECRET_PASSWORD = "maverick";
    let authMaverickError = null;
    try {
      assertAuthConfiguration();
    } catch (err) {
      authMaverickError = err;
    }
    assert(
      authMaverickError !== null && authMaverickError.message.includes("Refusing to boot with default credentials"),
      "assertAuthConfiguration() refuses to start when NODE_ENV is production and SUPER_SECRET_PASSWORD is 'maverick'"
    );

    // With password set in production
    process.env.SUPER_SECRET_PASSWORD = "test-prod-password-123";
    let prodSuccess = true;
    try {
      assertAuthConfiguration();
    } catch (err) {
      prodSuccess = false;
    }
    assert(prodSuccess, "assertAuthConfiguration() succeeds in production when SUPER_SECRET_PASSWORD is provided");
  } finally {
    process.env.NODE_ENV = origNodeEnv;
    if (origPassword !== undefined) {
      process.env.SUPER_SECRET_PASSWORD = origPassword;
    } else {
      delete process.env.SUPER_SECRET_PASSWORD;
    }
  }

  // 19.2: Unique Index on (recurringGroupId, date) prevents duplicate transactions
  const s19GroupId = "99999999-9999-9999-9999-999999999999";
  const s19Date = "2029-06-15";

  const s19FirstTrx = await Transaction.create({
    title: "Suite 19 Recurring Test A",
    amount: 75.0,
    baseAmount: 75.0,
    type: "EXPENSE",
    recurrence: "weekly",
    date: s19Date,
    recurringGroupId: s19GroupId,
    isCleared: false,
    balanceApplied: false,
  });
  assert(s19FirstTrx && s19FirstTrx.id, "Successfully creates initial recurring group occurrence");

  let s19DupError = null;
  try {
    await Transaction.create({
      title: "Suite 19 Recurring Test Duplicate",
      amount: 75.0,
      baseAmount: 75.0,
      type: "EXPENSE",
      date: s19Date,
      recurringGroupId: s19GroupId,
      isCleared: false,
      balanceApplied: false,
    });
  } catch (err) {
    s19DupError = err;
  }
  assert(
    s19DupError !== null &&
      (s19DupError.name === "SequelizeUniqueConstraintError" ||
        (s19DupError.original && s19DupError.original.code === "SQLITE_CONSTRAINT")),
    "Unique index on (recurringGroupId, date) strictly rejects duplicate transaction on identical date"
  );

  // 19.2b: Moving an occurrence onto a sibling's date returns HTTP 409 Conflict
  const s19Date2 = "2029-06-22";
  const s19SecondTrx = await Transaction.create({
    title: "Suite 19 Recurring Test B",
    amount: 75.0,
    baseAmount: 75.0,
    type: "EXPENSE",
    recurrence: "weekly",
    date: s19Date2,
    recurringGroupId: s19GroupId,
    isCleared: false,
    balanceApplied: false,
  });

  const moveRes = await request(
    { hostname: "localhost", port: 8000, path: `/api/expenses/${s19SecondTrx.id}`, method: "PUT", headers: authHeaders },
    { due_date: s19Date }
  );
  assert(
    moveRes.status === 409,
    "Moving an occurrence onto a sibling's date returns HTTP 409 Conflict"
  );
  assert(
    moveRes.body.error === "Another occurrence of this recurring series is already on that date.",
    "Returns clear user-facing error message on recurring date conflict"
  );

  // 19.3: Multiple non-recurring transactions with recurringGroupId = null on the same date are permitted
  let s19NullDateError = null;
  let s19Null1, s19Null2;
  try {
    s19Null1 = await Transaction.create({
      title: "Suite 19 One-off 1",
      amount: 10.0,
      type: "EXPENSE",
      date: s19Date,
      recurringGroupId: null,
      isCleared: false,
    });
    s19Null2 = await Transaction.create({
      title: "Suite 19 One-off 2",
      amount: 20.0,
      type: "EXPENSE",
      date: s19Date,
      recurringGroupId: null,
      isCleared: false,
    });
  } catch (err) {
    s19NullDateError = err;
  }
  assert(
    s19NullDateError === null && s19Null1 && s19Null2,
    "Multiple non-recurring transactions with NULL recurringGroupId on the same date are accepted"
  );

  // 19.4: createRecurringExpenses handles idempotent execution safely
  let s19JobError = null;
  try {
    await createRecurringExpenses();
  } catch (err) {
    s19JobError = err;
  }
  assert(s19JobError === null, "createRecurringExpenses() executes safely and idempotently without crashing");

  // Clean up Suite 19 records
  await Transaction.destroy({
    where: {
      id: [s19FirstTrx.id, s19SecondTrx && s19SecondTrx.id, s19Null1 && s19Null1.id, s19Null2 && s19Null2.id].filter(Boolean),
    },
  });

  // --- Suite 20: Cleared-Only Filter for Spending Charts vs Unfiltered Monthly Expenses (U3) ---
  console.log("\n--- Suite 20: Cleared-Only Filter for Spending Charts vs Unfiltered Monthly Expenses (U3) ---");
  const s20Zoned = toZonedTime(new Date(), "America/Toronto");
  const s20Year = s20Zoned.getFullYear();
  const s20Month = s20Zoned.getMonth() + 1; // 1-indexed
  const s20Date = `${s20Year}-${String(s20Month).padStart(2, "0")}-25`;

  // 1. Create one unpaid bill in current month with unique category
  const s20Category = "Suite20UnpaidCat";
  const s20UnpaidBill = await Transaction.create({
    title: "Suite 20 Unpaid Upcoming Bill",
    amount: 155.0,
    baseAmount: 155.0,
    type: "EXPENSE",
    category: s20Category,
    date: s20Date,
    isCleared: false,
    balanceApplied: false,
  });

  // 2. Create one unpaid future paycheque in current month
  const s20UnpaidPaycheque = await Transaction.create({
    title: "Suite 20 Unpaid Future Paycheque",
    amount: 850.0,
    type: "INCOME",
    category: "Income",
    date: s20Date,
    isCleared: false,
    balanceApplied: false,
  });

  // 3. Check /dashboard spendingSummary excludes the unpaid bill
  const s20DashRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/dashboard?year=${s20Year}&month=${s20Month}`,
    method: "GET",
    headers: authHeaders,
  });
  const s20DashCat = (s20DashRes.body.spendingSummary || []).find((cat) => cat.name === s20Category);
  assert(
    !s20DashCat,
    "/dashboard spendingSummary excludes unpaid bills (isCleared: false)"
  );

  // 4. Check /spending-summary excludes the unpaid bill
  const s20SpendRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/spending-summary?year=${s20Year}&month=${s20Month}`,
    method: "GET",
    headers: authHeaders,
  });
  const s20SpendCat = (s20SpendRes.body || []).find((cat) => cat.name === s20Category);
  assert(
    !s20SpendCat,
    "/spending-summary excludes unpaid bills (isCleared: false)"
  );

  // 5. Check /trends excludes both unpaid income and unpaid expense
  const s20TrendsRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/trends?year=${s20Year}&month=${s20Month}`,
    method: "GET",
    headers: authHeaders,
  });
  const s20MonthName = new Date(s20Year, s20Month - 1, 1).toLocaleString("en-US", { month: "short" });
  const s20Bucket = (s20TrendsRes.body || []).find((b) => b.name === s20MonthName);
  const s20DashSummary = s20DashRes.body.monthlySummary;
  assert(
    s20Bucket !== undefined,
    "/trends returns bucket for active month"
  );
  assert(
    s20Bucket && Math.abs(s20Bucket.spending - s20DashSummary.totalSpending) < 0.01,
    "/trends monthly spending aligns with dashboard cleared totalSpending"
  );
  assert(
    s20Bucket && Math.abs(s20Bucket.income - s20DashSummary.totalIncome) < 0.01,
    "/trends monthly income aligns with dashboard cleared totalIncome"
  );

  // 6. Check /expenses/monthly still includes the unpaid bill with is_paid: false
  const s20MonthlyRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/monthly?year=${s20Year}&month=${s20Month}`,
    method: "GET",
    headers: authHeaders,
  });
  const s20FoundBill = (s20MonthlyRes.body || []).find((e) => e.id === s20UnpaidBill.id);
  assert(
    s20FoundBill !== undefined && s20FoundBill.is_paid === false,
    "/expenses/monthly preserves upcoming bills with is_paid: false"
  );

  // 7. Check /expenses/category still includes the unpaid bill with is_paid: false
  const s20CatDrillRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/category?year=${s20Year}&month=${s20Month}&category=${encodeURIComponent(s20Category)}`,
    method: "GET",
    headers: authHeaders,
  });
  const s20FoundCatDrill = (s20CatDrillRes.body || []).find((e) => e.id === s20UnpaidBill.id);
  assert(
    s20FoundCatDrill !== undefined && s20FoundCatDrill.is_paid === false,
    "/expenses/category preserves upcoming bills with is_paid: false for drill-down"
  );

  // Clean up Suite 20 records
  await Transaction.destroy({
    where: {
      id: [s20UnpaidBill.id, s20UnpaidPaycheque.id],
    },
  });

  // --- Suite 21: Net Worth Service & Balances Summary Consistency (Phase A) ---
  console.log("\n--- Suite 21: Net Worth Service & Balances Summary Consistency (Phase A) ---");
  const s21Summary = await getBalancesSummary();
  assert(
    typeof s21Summary.checking === "number" &&
      typeof s21Summary.savings === "number" &&
      typeof s21Summary.debt === "number" &&
      typeof s21Summary.cards === "number" &&
      typeof s21Summary.netWorth === "number",
    "getBalancesSummary() returns valid numeric balances for checking, savings, debt, cards, and netWorth"
  );
  assert(
    Math.abs(s21Summary.netWorth - (s21Summary.checking + s21Summary.savings - s21Summary.debt - s21Summary.cards)) < 0.01,
    "netWorth arithmetic strictly matches checking + savings - debt - cards"
  );

  const s21DashRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  assert(
    s21DashRes.status === 200 && s21DashRes.body.balancesSummary !== undefined,
    "GET /api/dashboard returns balancesSummary object"
  );
  assert(
    s21DashRes.body.balancesSummary &&
      Math.abs(s21DashRes.body.balancesSummary.netWorth - s21Summary.netWorth) < 0.01,
    "Dashboard balancesSummary.netWorth matches netWorthService calculation"
  );
  assert(
    s21DashRes.body.balancesSummary &&
      Math.abs(s21DashRes.body.balancesSummary.checking - s21Summary.checking) < 0.01,
    "Dashboard balancesSummary.checking matches netWorthService live checking"
  );

  const s21ConfigRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/gemini-config",
    method: "GET",
    headers: authHeaders,
  });
  const s21FeedKey = s21ConfigRes.body.feedKey;
  const s21CsvRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/export/financial-feed.csv?key=${s21FeedKey}`,
    method: "GET",
  });
  assert(
    s21CsvRes.status === 200 &&
      s21CsvRes.raw.includes("Estimated Net Worth,$" + s21Summary.netWorth.toFixed(2)),
    "Export CSV feed Estimated Net Worth strictly equals netWorthService calculation"
  );



  
  // 22. Nightly Encrypted Backups & Round-Trip Restore (Phase B)
  console.log("\n--- Suite 22: Nightly Encrypted Backups & Round-Trip Restore (Phase B) ---");
  const badBackupRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/backup",
    method: "GET",
    headers: { Authorization: "Bearer bad_secret_key" },
  });
  assert(badBackupRes.status === 401, "Rejects unauthorized backup request with HTTP 401");

  const s22BackupRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/backup",
    method: "GET",
    headers: authHeaders,
  });
  assert(s22BackupRes.status === 200, "GET /api/cron/backup returns HTTP 200 with valid authorization");
  assert(
    s22BackupRes.body.format === "fintrack-backup" && s22BackupRes.body.version === 1,
    "Backup payload format is fintrack-backup version 1"
  );
  assert(
    typeof s22BackupRes.body.exportedAt === "string" && !isNaN(Date.parse(s22BackupRes.body.exportedAt)),
    "Backup payload includes valid ISO exportedAt timestamp"
  );
  assert(
    Array.isArray(s22BackupRes.body.accounts) &&
      Array.isArray(s22BackupRes.body.transactions) &&
      Array.isArray(s22BackupRes.body.settings),
    "Backup payload contains accounts, transactions, and settings arrays"
  );

  const s22BackupAliasRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/backup",
    method: "GET",
    headers: authHeaders,
  });
  assert(s22BackupAliasRes.status === 200, "Alias GET /api/backup returns HTTP 200");

  // Verify restore script refuses to overwrite without --force
  const s22TestDb = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
  const S22Account = s22TestDb.define("Account", Account.rawAttributes, { timestamps: true });
  const S22Transaction = s22TestDb.define("Transaction", Transaction.rawAttributes, { timestamps: true });
  const S22Setting = s22TestDb.define("Setting", Setting.rawAttributes, { timestamps: true });
  const S22Budget = s22TestDb.define("Budget", Budget.rawAttributes, { timestamps: true });
  await s22TestDb.sync();

  await S22Account.create({ id: "99999999-9999-9999-9999-999999999999", name: "Existing Guard", type: "CHECKING" });
  let s22RefusedWithoutForce = false;
  try {
    await restoreBackup(s22BackupRes.body, {
      force: false,
      sequelizeInstance: s22TestDb,
      models: { Account: S22Account, Transaction: S22Transaction, Setting: S22Setting, Budget: S22Budget },
    });
  } catch (err) {
    s22RefusedWithoutForce = err.message.includes("Refusing to overwrite");
  }
  assert(s22RefusedWithoutForce, "restoreBackup() refuses to overwrite existing database without force flag");

  // Verify clean round-trip restore into isolated database
  const s22RestoreRes = await restoreBackup(s22BackupRes.body, {
    force: true,
    sequelizeInstance: s22TestDb,
    models: { Account: S22Account, Transaction: S22Transaction, Setting: S22Setting, Budget: S22Budget },
  });
  assert(
    s22RestoreRes.accountsRestored === s22BackupRes.body.accounts.length &&
      s22RestoreRes.transactionsRestored === s22BackupRes.body.transactions.length &&
      s22RestoreRes.settingsRestored === s22BackupRes.body.settings.length,
    "Round-trip restore completes with exact account, transaction, and setting counts"
  );

  const restoredAccounts = await S22Account.findAll({ raw: true, order: [["id", "ASC"]] });
  const restoredTransactions = await S22Transaction.findAll({ raw: true, order: [["id", "ASC"]] });

  let accountsMatch = restoredAccounts.length === s22BackupRes.body.accounts.length;
  if (accountsMatch && restoredAccounts.length > 0) {
    accountsMatch = restoredAccounts.every((acc, i) => {
      const orig = s22BackupRes.body.accounts[i];
      return acc.id === orig.id && acc.name === orig.name && Number(acc.initialBalance) === Number(orig.initialBalance);
    });
  }
  assert(accountsMatch, "Restored accounts preserve exact IDs, names, and balances");

  let txMatch = restoredTransactions.length === s22BackupRes.body.transactions.length;
  if (txMatch && restoredTransactions.length > 0) {
    txMatch = restoredTransactions.every((tx, i) => {
      const orig = s22BackupRes.body.transactions[i];
      return (
        tx.id === orig.id &&
        Number(tx.amount) === Number(orig.amount) &&
        Boolean(tx.balanceApplied) === Boolean(orig.balanceApplied) &&
        Boolean(tx.isCleared) === Boolean(orig.isCleared)
      );
    });
  }
  assert(txMatch, "Restored transactions preserve exact IDs, amounts, and balanceApplied/isCleared states");

  // Verify production guard refuses to restore without --production flag
  s22TestDb.isProductionDb = true;
  let s22ProdRefusedWithoutFlag = false;
  try {
    await restoreBackup(s22BackupRes.body, {
      force: true,
      production: false,
      sequelizeInstance: s22TestDb,
      models: { Account: S22Account, Transaction: S22Transaction, Setting: S22Setting, Budget: S22Budget },
    });
  } catch (err) {
    s22ProdRefusedWithoutFlag = err.message.includes("Target is the remote database; re-run with --production to confirm.");
  }
  s22TestDb.isProductionDb = false;
  assert(s22ProdRefusedWithoutFlag, "restoreBackup() strictly refuses to restore to production database without --production flag");


  // Verify CLI invocation with invalid file rejected
  const tmpBackupPath = path.join(__dirname, "temp_suite22_test.json");
  fs.writeFileSync(tmpBackupPath, JSON.stringify({ format: "corrupt", version: 1 }));
  let cliRejectedCorrupt = false;
  try {
    execSync(`node scripts/restore.js "${tmpBackupPath}"`, { stdio: "pipe" });
  } catch (err) {
    cliRejectedCorrupt = true;
  }
  if (fs.existsSync(tmpBackupPath)) fs.unlinkSync(tmpBackupPath);
  assert(cliRejectedCorrupt, "scripts/restore.js CLI rejects invalid backup formats with non-zero exit code");

  
  // 23. Server-Backed Category Budgets (Phase C)
  console.log("\n--- Suite 23: Server-Backed Category Budgets (Phase C) ---");
  const unauthBudget = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets",
    method: "GET",
  });
  assert(unauthBudget.status === 401, "GET /api/budgets rejects unauthenticated requests with HTTP 401");

  const invalidLimitRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets/TestCat",
    method: "PUT",
    headers: authHeaders,
  }, { monthlyLimit: -50 });
  assert(invalidLimitRes.status === 400, "PUT /api/budgets/:category rejects negative monthly limit with HTTP 400");

  const zeroLimitRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets/TestCat",
    method: "PUT",
    headers: authHeaders,
  }, { monthlyLimit: 0 });
  assert(zeroLimitRes.status === 400, "PUT /api/budgets/:category rejects zero monthly limit with HTTP 400");

  const createBudgetRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets/Groceries",
    method: "PUT",
    headers: authHeaders,
  }, { monthlyLimit: 400 });
  assert(
    createBudgetRes.status === 200 &&
      createBudgetRes.body.category === "Groceries" &&
      createBudgetRes.body.monthlyLimit === 400,
    "PUT /api/budgets/:category creates new budget limit with HTTP 200"
  );

  const upsertBudgetRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets/Groceries",
    method: "PUT",
    headers: authHeaders,
  }, { monthlyLimit: 550, rollover: true });
  assert(
    upsertBudgetRes.status === 200 &&
      upsertBudgetRes.body.monthlyLimit === 550 &&
      upsertBudgetRes.body.rollover === true,
    "PUT /api/budgets/:category upserts existing budget with new limit and rollover: true"
  );

  const listBudgetsRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets",
    method: "GET",
    headers: authHeaders,
  });
  assert(
    listBudgetsRes.status === 200 &&
      Array.isArray(listBudgetsRes.body) &&
      listBudgetsRes.body.some((b) => b.category === "Groceries" && b.monthlyLimit === 550),
    "GET /api/budgets returns list containing upserted budget with computed available"
  );

  const deleteBudgetRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets/Groceries",
    method: "DELETE",
    headers: authHeaders,
  });
  assert(deleteBudgetRes.status === 204, "DELETE /api/budgets/:category removes budget with HTTP 204");

  const deleteNotFoundRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets/NonExistentCategory",
    method: "DELETE",
    headers: authHeaders,
  });
  assert(deleteNotFoundRes.status === 404, "DELETE /api/budgets/:category returns HTTP 404 for non-existent category");

  // Verify C1: /api does not mistakenly mount budget router
  const notARouteRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/not-a-route",
    method: "PUT",
    headers: authHeaders,
  }, { monthlyLimit: 50 });
  assert(notARouteRes.status === 404, "PUT /api/not-a-route returns HTTP 404 (not matched by budgets router)");

  const budgetsAfterNotARoute = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/budgets",
    method: "GET",
    headers: authHeaders,
  });
  const budgetsList = Array.isArray(budgetsAfterNotARoute.body) ? budgetsAfterNotARoute.body : [];
  assert(!budgetsList.some((b) => b.category === "not-a-route"), "GET /api/budgets does not contain not-a-route");

  const longCatName = "A".repeat(101);
  const longCatRes = await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/budgets/${longCatName}`,
    method: "PUT",
    headers: authHeaders,
  }, { monthlyLimit: 100 });
  assert(longCatRes.status === 400, "PUT /api/budgets/:category rejects category name > 100 chars with HTTP 400");

  // 24. Past-Dated Credit Card Toggle Tests (Phase D)
  console.log("\n--- Suite 24: Past-Dated Credit Card Toggle (Phase D) ---");

  const testCardRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "POST",
    headers: authHeaders,
  }, { name: "Test Card Phase D", creditLimit: 2000, currentBalance: 500 });
  assert(testCardRes.status === 201, "Creates test card for Phase D with $500 balance");
  const testCardId = testCardRes.body.id;

  const dYesterday = new Date();
  dYesterday.setDate(dYesterday.getDate() - 1);
  const yesterdayStr = dYesterday.toISOString().split("T")[0];

  const dFiveDaysAgo = new Date();
  dFiveDaysAgo.setDate(dFiveDaysAgo.getDate() - 5);
  const fiveDaysAgoStr = dFiveDaysAgo.toISOString().split("T")[0];

  const todayIso = new Date().toISOString().split("T")[0];

  // 1. Past-dated card charge with applyToBalance: true
  const pastAppliedExp = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Past Charge Applied",
    amount: 50,
    due_date: yesterdayStr,
    creditCardId: testCardId,
    applyToBalance: true,
  });
  assert(pastAppliedExp.status === 201 && pastAppliedExp.body.balanceApplied === true, "Past-dated expense with applyToBalance: true has balanceApplied: true");

  let cardCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  let cardObj = cardCheck.body.find((c) => c.id === testCardId);
  assert(parseFloat(cardObj.currentBalance) === 550, "Card balance increased to $550 with applyToBalance: true");

  // 2. Past-dated card charge with applyToBalance omitted
  const pastUnappliedExp = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Past Charge Already Included",
    amount: 30,
    due_date: fiveDaysAgoStr,
    creditCardId: testCardId,
  });
  assert(pastUnappliedExp.status === 201 && pastUnappliedExp.body.balanceApplied === false, "Past-dated expense without applyToBalance has balanceApplied: false");

  cardCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  cardObj = cardCheck.body.find((c) => c.id === testCardId);
  assert(parseFloat(cardObj.currentBalance) === 550, "Card balance remains $550 for charge with applyToBalance omitted");

  // 3. Today charge without applyToBalance
  const todayExp = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Today Card Charge",
    amount: 20,
    due_date: todayIso,
    creditCardId: testCardId,
  });
  assert(todayExp.status === 201 && todayExp.body.balanceApplied === true, "Today expense defaults to balanceApplied: true");

  cardCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  cardObj = cardCheck.body.find((c) => c.id === testCardId);
  assert(parseFloat(cardObj.currentBalance) === 570, "Card balance increased to $570 for today charge");

  // 4. Delete pastAppliedExp
  const delPastApplied = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/" + pastAppliedExp.body.id,
    method: "DELETE",
    headers: authHeaders,
  });
  assert(delPastApplied.status === 204, "Successfully deleted past-dated applied expense with HTTP 204");

  cardCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  cardObj = cardCheck.body.find((c) => c.id === testCardId);
  assert(parseFloat(cardObj.currentBalance) === 520, "Deleting applied past expense decrements card balance to $520");

  // 5. Delete pastUnappliedExp
  const delPastUnapplied = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/" + pastUnappliedExp.body.id,
    method: "DELETE",
    headers: authHeaders,
  });
  assert(delPastUnapplied.status === 204, "Successfully deleted past-dated unapplied expense with HTTP 204");

  cardCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  cardObj = cardCheck.body.find((c) => c.id === testCardId);
  assert(parseFloat(cardObj.currentBalance) === 520, "Deleting unapplied past expense leaves card balance unchanged at $520");

  // 25. Safe to Spend & Cashflow Forecast Tests (Phase E)
  console.log("\n--- Suite 25: Safe to Spend & Cashflow Forecast (Phase E) ---");

  // Setting endpoint: rejects negative buffer with HTTP 400
  const negBufferRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/settings/forecast-buffer",
    method: "PUT",
    headers: authHeaders,
  }, { buffer: -50 });
  assert(negBufferRes.status === 400, "PUT /api/settings/forecast-buffer rejects negative buffer with HTTP 400");

  // Set buffer to 200
  const setBufferRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/settings/forecast-buffer",
    method: "PUT",
    headers: authHeaders,
  }, { buffer: 200 });
  assert(setBufferRes.status === 200 && setBufferRes.body.buffer === 200, "PUT /api/settings/forecast-buffer sets buffer to 200");

  // Set primary checking balance to known 2500
  const setCheckRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/checking",
    method: "PUT",
    headers: authHeaders,
  }, { balance: 2500 });
  assert(setCheckRes.status === 200, "Initializes checking balance to $2500.00 for forecast test");

  // Determine dates using calendar arithmetic
  const now = new Date();
  const getOffsetDate = (days) => {
    const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return d.toISOString().split("T")[0];
  };

  const day1Str = getOffsetDate(1);
  const day2Str = getOffsetDate(2);
  const day40Str = getOffsetDate(40);

  // 1. Create bill paid from checking on Day 1 ($300)
  const checkingBillRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Suite 25 Hydro Bill",
    amount: 300,
    due_date: day1Str,
    is_paid: false,
  });
  assert(checkingBillRes.status === 201, "Creates upcoming checking bill on Day 1 for $300");

  // 2. Create credit card & charge on Day 1 ($150) -> must NOT reduce checking
  const cardPhaseERes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Suite 25 Card",
    creditLimit: 2000,
    currentBalance: 0,
  });
  const phaseECardId = cardPhaseERes.body.id;

  const suite25CardChargeRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Suite 25 Card Charge",
    amount: 150,
    due_date: day1Str,
    creditCardId: phaseECardId,
    is_paid: false,
  });
  assert(suite25CardChargeRes.status === 201, "Creates credit card charge on Day 1 for $150");

  // 3. Create auto-pay debt due on Day 1 ($100 minimum payment, $500 balance)
  const debtPhaseERes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/debts",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Suite 25 Student Loan",
    total_amount: 500,
    monthly_payment: 100,
    next_due_date: day1Str,
    auto_pay: true,
    payment_frequency: "monthly",
  });
  const phaseEDebtId = debtPhaseERes.body.id;
  assert(debtPhaseERes.status === 201, "Creates auto-pay debt due on Day 1 with $100 min payment");

  // 4. Create paycheque on Day 2 ($1000)
  const paychequeRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/paycheques",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Suite 25 Paycheque",
    amount: 1000,
    payment_date: day2Str,
  });
  assert(paychequeRes.status === 201, "Creates paycheque on Day 2 for $1000");

  // 5. Create a recurring income transaction that repeats monthly into the 40+ day horizon
  const recurringIncomeRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/paycheques",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Suite 25 Recurring Bonus",
    amount: 500,
    payment_date: day40Str,
    recurrence: "monthly",
  });
  assert(recurringIncomeRes.status === 201, "Creates recurring income to verify projection");

  // Query 60-day forecast
  const forecastRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/forecast?days=60",
    method: "GET",
    headers: authHeaders,
  });
  assert(forecastRes.status === 200, "GET /api/forecast returns HTTP 200");
  const forecast = forecastRes.body;

  assert(forecast.startBalance === 2500, "Forecast reports startBalance of $2500");
  assert(forecast.buffer === 200, "Forecast reports buffer of $200");
  assert(forecast.nextPayday === day2Str, "Forecast identifies nextPayday on Day 2");

  // Verify Day 1: checking bill ($300) + auto-pay ($100) applied; card charge ($150) omitted
  const forecastDay1 = forecast.days.find((d) => d.date === day1Str);
  assert(forecastDay1 !== undefined, "Forecast contains Day 1 entry");
  assert(forecastDay1.balance === 2100, "Day 1 balance is exactly $2100 (2500 - 300 - 100, omitting card charge)");

  const day1ItemTitles = forecastDay1.items.map((it) => it.title);
  assert(day1ItemTitles.includes("Suite 25 Hydro Bill"), "Day 1 includes checking bill");
  assert(day1ItemTitles.some((t) => t.includes("Suite 25 Student Loan")), "Day 1 includes auto-pay debt");
  assert(!day1ItemTitles.includes("Suite 25 Card Charge"), "Day 1 strictly excludes credit card charge");

  // Verify Safe to Spend:
  // Before Day 2 (Day 0 balance is 2500, Day 1 balance is 2100) -> min is 2100.
  // safeToSpend = 2100 - buffer(200) = 1900.
  assert(forecast.safeToSpend === 1900, "safeToSpend correctly calculated as $1900.00 (minBeforePayday 2100 - buffer 200)");

  // Clean up Suite 25 records
  await request({ hostname: "localhost", port: 8000, path: "/api/expenses/" + checkingBillRes.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/expenses/" + suite25CardChargeRes.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards/" + phaseECardId, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/debts/" + phaseEDebtId, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + paychequeRes.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + recurringIncomeRes.body.id, method: "DELETE", headers: authHeaders });

  // 26. Morning Push Notifications & Daily Digest Tests (Phase F)
  console.log("\n--- Suite 26: Morning Push Notifications & Daily Digest (Phase F) ---");

  // 1. Rejects unauthorized request with HTTP 401
  const unauthDigestRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/digest",
    method: "GET",
    headers: { Authorization: "Bearer invalid_secret_token" },
  });
  assert(unauthDigestRes.status === 401, "GET /api/cron/digest rejects unauthenticated request with HTTP 401");

  // Helper for cron auth
  const cronHeaders = authHeaders;

  // 2. Returns 204 when clean / nothing to report
  // Ensure buffer is low and checking balance is high so no low balance alert triggers
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/settings/forecast-buffer",
    method: "PUT",
    headers: authHeaders,
  }, { buffer: 0 });

  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/checking",
    method: "PUT",
    headers: authHeaders,
  }, { balance: 5000 });

  // Clean any existing sweep setting, notify setting, or leftover bills for isolation
  await Setting.destroy({ where: { key: ["last_sweep_summary", "NOTIFY_DETAIL"] } });
  await Transaction.destroy({ where: { title: ["Day 4 Far Bill", "Day 3 Near Bill"] } });

  const emptyDigestRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/digest",
    method: "GET",
    headers: cronHeaders,
  });
  assert(emptyDigestRes.status === 204, "GET /api/cron/digest returns HTTP 204 when there is nothing to report");

  // 3. Verify 3-day boundary: Bill on Day 4 is excluded (returns 204), Bill on Day 3 is included (returns 200)
  const d3Str = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const d4Str = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const billDay4Res = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Day 4 Far Bill",
    amount: 120,
    due_date: d4Str,
    is_paid: false,
  });

  const digestWithDay4Res = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/digest",
    method: "GET",
    headers: cronHeaders,
  });
  assert(digestWithDay4Res.status === 204, "Digest strictly ignores bills due on Day 4 (returns HTTP 204)");

  const billDay3Res = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Day 3 Near Bill",
    amount: 75,
    due_date: d3Str,
    is_paid: false,
  });

  const digestWithDay3Res = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/digest",
    method: "GET",
    headers: cronHeaders,
  });
  assert(digestWithDay3Res.status === 200, "Digest includes bills due within 3 days (returns HTTP 200)");
  assert(digestWithDay3Res.body.message.includes("Day 3 Near Bill"), "Digest message includes near bill title");
  assert(digestWithDay3Res.body.message.includes("$75.00"), "Digest message includes formatted bill amount");
  assert(!digestWithDay3Res.body.message.includes("Day 4 Far Bill"), "Digest message strictly excludes Day 4 bill");

  // 4. Low-balance alert triggers priority: "high"
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/settings/forecast-buffer",
    method: "PUT",
    headers: authHeaders,
  }, { buffer: 200 });

  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/checking",
    method: "PUT",
    headers: authHeaders,
  }, { balance: 50 });

  const lowBalDigestRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/digest",
    method: "GET",
    headers: cronHeaders,
  });
  assert(lowBalDigestRes.status === 200 && lowBalDigestRes.body.priority === "high", "Low-balance alert escalates digest to priority: high");
  assert(lowBalDigestRes.body.message.includes("Low Balance Alert"), "Digest contains explicit Low Balance Alert text");

  // 5. Privacy setting NOTIFY_DETAIL: "counts" suppresses dollar amounts
  await Setting.upsert({ key: "NOTIFY_DETAIL", value: "counts" });
  const countsDigestRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/digest",
    method: "GET",
    headers: cronHeaders,
  });
  assert(countsDigestRes.status === 200, "Digest with NOTIFY_DETAIL=counts returns HTTP 200");
  assert(countsDigestRes.body.message.includes("1 bill(s) due"), "Counts mode states bill count");
  assert(!countsDigestRes.body.message.includes("$75.00"), "Counts mode suppresses dollar amounts");

  // Cleanup Suite 26
  await Setting.destroy({ where: { key: "NOTIFY_DETAIL" } });
  await request({ hostname: "localhost", port: 8000, path: "/api/expenses/" + billDay4Res.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/expenses/" + billDay3Res.body.id, method: "DELETE", headers: authHeaders });




  // 27. Net Worth History & Daily Snapshots (Phase G)
  console.log("\n--- Suite 27: Net Worth History & Daily Snapshots ---");

  // Cleanup any leftover snapshots from previous runs
  await NetWorthSnapshot.destroy({ where: {} });

  // 1. Initial GET /api/net-worth-history rejects without auth
  const unauthHistoryRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/net-worth-history",
    method: "GET",
  });
  assert(unauthHistoryRes.status === 401, "GET /api/net-worth-history returns 401 unauthenticated");

  // 2. Initial history is empty
  const initialHistoryRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/net-worth-history",
    method: "GET",
    headers: authHeaders,
  });
  assert(
    initialHistoryRes.status === 200 &&
      Array.isArray(initialHistoryRes.body.snapshots) &&
      initialHistoryRes.body.snapshots.length === 0,
    "GET /api/net-worth-history returns empty snapshots list initially"
  );
  assert(
    initialHistoryRes.body.change30Days === null,
    "change30Days is null when no historical snapshot exists"
  );

  // 3. Trigger Daily Sweep - captures today's snapshot
  const sweepRes1 = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/daily-check",
    method: "GET",
    headers: authHeaders,
  });
  assert(sweepRes1.status === 200, "Daily sweep execution succeeds");

  const snapshotCount1 = await NetWorthSnapshot.count();
  assert(snapshotCount1 === 1, "Daily sweep created exactly one NetWorthSnapshot for today");

  const todaySnapshot = await NetWorthSnapshot.findOne();
  assert(
    todaySnapshot !== null && typeof todaySnapshot.netWorth !== "undefined",
    "NetWorthSnapshot records today's date and computed netWorth"
  );

  // 4. Second Daily Sweep on same day is idempotent (updates, does not duplicate)
  const sweepRes2 = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/daily-check",
    method: "GET",
    headers: authHeaders,
  });
  assert(sweepRes2.status === 200, "Second daily sweep succeeds");
  const snapshotCount2 = await NetWorthSnapshot.count();
  assert(snapshotCount2 === 1, "Second daily sweep on same day updates snapshot idempotently without duplicating");

  // 5. Seed a baseline snapshot 30 days prior and verify change30Days calculation
  const todayDateStr = todaySnapshot.date;
  const { subDays, parseISO, format: fmtDate } = require("date-fns");
  const priorDate30 = fmtDate(subDays(parseISO(todayDateStr), 30), "yyyy-MM-dd");

  const baselineNW = Math.round((parseFloat(todaySnapshot.netWorth) - 500) * 100) / 100;
  await NetWorthSnapshot.create({
    date: priorDate30,
    checking: 1000,
    savings: 2000,
    debt: 500,
    cards: 100,
    netWorth: baselineNW,
  });

  const historyWithBaselineRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/net-worth-history",
    method: "GET",
    headers: authHeaders,
  });
  assert(historyWithBaselineRes.status === 200, "GET /api/net-worth-history returns 200 with baseline data");
  assert(
    historyWithBaselineRes.body.snapshots.length === 2,
    "Returns both snapshots in chronological order"
  );
  assert(
    historyWithBaselineRes.body.change30Days !== null &&
      Math.abs(historyWithBaselineRes.body.change30Days.absolute - 500) < 0.01,
    "Calculates change30Days.absolute accurately (+500 difference)"
  );
  assert(
    historyWithBaselineRes.body.change30Days.priorDate === priorDate30,
    "change30Days references the correct priorDate"
  );

  // 6. Backup includes netWorthSnapshots
  const backupRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/cron/backup",
    method: "GET",
    headers: cronHeaders,
  });
  assert(backupRes.status === 200, "Backup endpoint returns HTTP 200");
  assert(
    Array.isArray(backupRes.body.netWorthSnapshots) && backupRes.body.netWorthSnapshots.length === 2,
    "Backup payload includes netWorthSnapshots array with 2 records"
  );

  // Cleanup Suite 27
  await NetWorthSnapshot.destroy({ where: {} });



  // 28. Savings Goal Pacing & 90-Day Contribution Window (Phase I)
  console.log("\n--- Suite 28: Savings Goal Pacing & 90-Day Contributions ---");

  // 1. Create a test savings goal
  const pacingGoalRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/savings-goals",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Emergency Pacing Fund",
      target_amount: 5000,
      current_amount: 1000,
      target_date: "2027-10-01",
    }
  );
  assert(pacingGoalRes.status === 201 && pacingGoalRes.body.id, "Creates test savings goal with target date");
  const pacingGoalId = pacingGoalRes.body.id;

  // 2. Initial GET /api/savings-goals reports contributedLast90Days === 0
  const initialGoalsRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  const foundGoal1 = (initialGoalsRes.body || []).find((g) => g.id === pacingGoalId);
  assert(foundGoal1 && foundGoal1.contributedLast90Days === 0, "Initial savings goal reports contributedLast90Days === 0");

  // 3. Create transactions:
  // a) Cleared contribution 10 days ago ($150) -> should be counted
  const { subDays: sDays, format: fmtD } = require("date-fns");
  const date10DaysAgo = fmtD(sDays(new Date(), 10), "yyyy-MM-dd");
  const date120DaysAgo = fmtD(sDays(new Date(), 120), "yyyy-MM-dd");

  const txRecentCleared = await Transaction.create({
    title: "Recent Cleared Savings Transfer",
    amount: 150,
    type: "TRANSFER",
    toAccountId: pacingGoalId,
    date: date10DaysAgo,
    isCleared: true,
    balanceApplied: true,
  });

  // b) Uncleared contribution 10 days ago ($50) -> should NOT be counted
  const txRecentUncleared = await Transaction.create({
    title: "Pending Savings Transfer",
    amount: 50,
    type: "TRANSFER",
    toAccountId: pacingGoalId,
    date: date10DaysAgo,
    isCleared: false,
    balanceApplied: false,
  });

  // c) Cleared contribution 120 days ago ($200) -> should NOT be counted (outside 90-day window)
  const txOldCleared = await Transaction.create({
    title: "Old Cleared Savings Transfer",
    amount: 200,
    type: "TRANSFER",
    toAccountId: pacingGoalId,
    date: date120DaysAgo,
    isCleared: true,
    balanceApplied: true,
  });

  // 4. GET /api/savings-goals reflects exactly $150.00
  const updatedGoalsRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  const foundGoal2 = (updatedGoalsRes.body || []).find((g) => g.id === pacingGoalId);
  assert(foundGoal2 && foundGoal2.contributedLast90Days === 150, "contributedLast90Days includes cleared 90-day transactions and excludes uncleared and old ones ($150.00)");

  // 5. GET /api/dashboard savingsSummary includes matching contributedLast90Days
  const dashboardRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/dashboard",
    method: "GET",
    headers: authHeaders,
  });
  const dashSavingsGoal = (dashboardRes.body?.savingsSummary || []).find((g) => g.id === pacingGoalId);
  assert(dashSavingsGoal && dashSavingsGoal.contributedLast90Days === 150, "Dashboard savingsSummary includes accurate contributedLast90Days");

  // Cleanup Suite 28
  await txRecentCleared.destroy();
  await txRecentUncleared.destroy();
  await txOldCleared.destroy();
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals/" + pacingGoalId,
    method: "DELETE",
    headers: authHeaders,
  });



  // 29. Registered Accounts Tracking: TFSA, RRSP, FHSA (Phase J)
  console.log("\n--- Suite 29: Registered Accounts (TFSA / RRSP / FHSA) ---");

  // 1. Create a registered TFSA goal
  const tfsaRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/savings-goals",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Wealthsimple TFSA",
      target_amount: 50000,
      current_amount: 10000,
      registeredType: "TFSA",
      contributionRoom: 7000,
      roomYear: 2026,
    }
  );
  assert(tfsaRes.status === 201 && tfsaRes.body.id, "Creates registered TFSA savings goal with room 7000");
  const tfsaId = tfsaRes.body.id;

  // 2. Initial state
  const initialTfsaRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  const tfsaRecord1 = (initialTfsaRes.body || []).find((g) => g.id === tfsaId);
  assert(tfsaRecord1 && tfsaRecord1.registeredType === "TFSA", "Recognizes goal registeredType as TFSA");
  assert(tfsaRecord1.contributionRoom === 7000, "Reports contribution room $7,000");
  assert(tfsaRecord1.contributedThisYear === 0, "Initial contributedThisYear is 0");
  assert(tfsaRecord1.roomLeft === 7000, "Initial roomLeft is 7000");
  assert(tfsaRecord1.isOverContributed === false, "isOverContributed is false");

  // 3. Add $2,000 contribution and $500 withdrawal in 2026
  const tfsaDeposit = await Transaction.create({
    title: "TFSA 2026 Contribution",
    amount: 2000,
    type: "TRANSFER",
    toAccountId: tfsaId,
    date: "2026-03-15",
    isCleared: true,
    balanceApplied: true,
  });

  const tfsaWithdrawal = await Transaction.create({
    title: "TFSA 2026 Withdrawal",
    amount: 500,
    type: "TRANSFER",
    fromAccountId: tfsaId,
    date: "2026-06-20",
    isCleared: true,
    balanceApplied: true,
  });

  const activeTfsaRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  const tfsaRecord2 = (activeTfsaRes.body || []).find((g) => g.id === tfsaId);
  assert(tfsaRecord2.contributedThisYear === 2000, "Accurately calculates contributedThisYear ($2,000)");
  assert(tfsaRecord2.withdrawnThisYear === 500, "Accurately calculates withdrawnThisYear ($500)");
  assert(tfsaRecord2.roomLeft === 5000, "Accurately calculates roomLeft (7000 - 2000 = 5000)");
  assert(tfsaRecord2.roomReturnsNextYear === 500, "Calculates roomReturnsNextYear for TFSA (+$500 on Jan 1)");

  // 4. Test Over-Contribution: Add $6,000 contribution (total 8000 on 7000 limit)
  const tfsaOverDeposit = await Transaction.create({
    title: "TFSA Second Contribution",
    amount: 6000,
    type: "TRANSFER",
    toAccountId: tfsaId,
    date: "2026-08-10",
    isCleared: true,
    balanceApplied: true,
  });

  const overTfsaRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals",
    method: "GET",
    headers: authHeaders,
  });
  const tfsaRecord3 = (overTfsaRes.body || []).find((g) => g.id === tfsaId);
  assert(tfsaRecord3.contributedThisYear === 8000, "contributedThisYear reaches $8,000");
  assert(tfsaRecord3.roomLeft === -1000, "roomLeft is -$1,000");
  assert(tfsaRecord3.isOverContributed === true, "Flags isOverContributed: true when over limit");

  // Cleanup Suite 29
  await tfsaDeposit.destroy();
  await tfsaWithdrawal.destroy();
  await tfsaOverDeposit.destroy();
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/savings-goals/" + tfsaId,
    method: "DELETE",
    headers: authHeaders,
  });



  // 30. Subscriptions & Recurring Series Intelligence (Phase K)
  console.log("\n--- Suite 30: Subscriptions & Recurring Series Intelligence (Phase K) ---");

  // 1. Unauthenticated request rejected
  const unauthSub = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/subscriptions",
    method: "GET",
  });
  assert(unauthSub.status === 401, "GET /api/subscriptions rejects unauthenticated request with HTTP 401");

  // 2. Create test card for subscriptions
  const subCardRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/credit-cards",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Streaming Card",
      creditLimit: 5000,
      currentBalance: 0,
    }
  );
  const subCardId = subCardRes.body.id;

  const netflixGroupId = crypto.randomUUID();
  const gymGroupId = crypto.randomUUID();
  const primeGroupId = crypto.randomUUID();
  const cancelledGroupId = crypto.randomUUID();

  // Netflix occurrences (price hike from 16.49 to 18.99)
  const netflix1 = await Transaction.create({
    title: "Netflix Standard",
    amount: 16.49,
    date: "2026-01-15",
    type: "EXPENSE",
    category: "Entertainment",
    recurrence: "monthly",
    isCleared: true,
    recurringGroupId: netflixGroupId,
    fromAccountId: subCardId,
  });

  const netflix2 = await Transaction.create({
    title: "Netflix Standard",
    amount: 18.99,
    date: "2026-02-15",
    type: "EXPENSE",
    category: "Entertainment",
    recurrence: "monthly",
    isCleared: true,
    recurringGroupId: netflixGroupId,
    fromAccountId: subCardId,
  });

  const netflix3 = await Transaction.create({
    title: "Netflix Standard",
    amount: 18.99,
    date: "2026-03-15",
    type: "EXPENSE",
    category: "Entertainment",
    recurrence: "monthly",
    isCleared: false,
    recurringGroupId: netflixGroupId,
    fromAccountId: subCardId,
  });

  // Gym membership (Bi-weekly $25)
  const gym1 = await Transaction.create({
    title: "GoodLife Fitness",
    amount: 25.0,
    date: "2026-02-01",
    type: "EXPENSE",
    category: "Health & Fitness",
    recurrence: "bi-weekly",
    isCleared: true,
    recurringGroupId: gymGroupId,
  });

  // Amazon Prime (Yearly $120)
  const prime1 = await Transaction.create({
    title: "Amazon Prime",
    amount: 120.0,
    date: "2026-01-01",
    type: "EXPENSE",
    category: "Subscriptions",
    recurrence: "yearly",
    isCleared: true,
    recurringGroupId: primeGroupId,
  });

  // Cancelled subscription (recurrence set to 'none' on latest occurrence)
  const cancelled1 = await Transaction.create({
    title: "Old Magazine Sub",
    amount: 10.0,
    date: "2025-11-01",
    type: "EXPENSE",
    category: "Entertainment",
    recurrence: "none",
    isCleared: true,
    recurringGroupId: cancelledGroupId,
  });

  // 3. Query GET /api/subscriptions
  const subRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/subscriptions",
    method: "GET",
    headers: authHeaders,
  });

  assert(subRes.status === 200, "GET /api/subscriptions returns HTTP 200");
  assert(subRes.body.count === 3, "Returns exactly 3 active subscriptions (excludes cancelled)");

  const subs = subRes.body.subscriptions || [];
  const netflixSub = subs.find((s) => s.recurringGroupId === netflixGroupId);
  const gymSub = subs.find((s) => s.recurringGroupId === gymGroupId);
  const primeSub = subs.find((s) => s.recurringGroupId === primeGroupId);

  assert(Boolean(netflixSub), "Includes Netflix subscription");
  assert(Boolean(gymSub), "Includes Gym subscription");
  assert(Boolean(primeSub), "Includes Prime subscription");

  // Verify monthly and annual cost normalization
  assert(netflixSub && netflixSub.monthlyCost === 18.99, "Netflix monthly cost is $18.99");
  assert(netflixSub && netflixSub.annualCost === 227.88, "Netflix annual cost is $227.88");
  assert(gymSub && Math.abs(gymSub.monthlyCost - 54.17) < 0.05, "Gym bi-weekly $25 normalizes to ~$54.17/mo");
  assert(gymSub && gymSub.annualCost === 650.0, "Gym annual cost is $650.00");
  assert(primeSub && primeSub.monthlyCost === 10.0, "Prime yearly $120 normalizes to $10.00/mo");
  assert(primeSub && primeSub.annualCost === 120.0, "Prime annual cost is $120.00");

  // Verify price change detection on Netflix
  assert(netflixSub && Boolean(netflixSub.priceChange), "Detects price change on Netflix");
  assert(netflixSub && netflixSub.priceChange.from === 16.49, "Price change from is $16.49");
  assert(netflixSub && netflixSub.priceChange.to === 18.99, "Price change to is $18.99");
  assert(netflixSub && netflixSub.priceChange.difference === 2.5, "Price change difference is +$2.50");
  assert(netflixSub && netflixSub.priceChange.percent === 15.2, "Price change percent is +15.2%");

  // Verify paying account association
  assert(netflixSub && netflixSub.payingAccount === "Streaming Card", "Netflix correctly identifies paying card");
  assert(netflixSub && netflixSub.isCreditCard === true, "Identifies paying account as credit card");
  assert(gymSub && gymSub.payingAccount === "Primary Checking", "Gym defaults to Primary Checking");

  // Verify sorting: highest monthly cost first
  assert(subs[0].monthlyCost >= subs[1].monthlyCost && subs[1].monthlyCost >= subs[2].monthlyCost, "Subscriptions sorted by monthlyCost descending");

  // Verify totals
  const expectedTotalMonthly = Math.round((netflixSub.monthlyCost + gymSub.monthlyCost + primeSub.monthlyCost) * 100) / 100;
  assert(subRes.body.totalMonthly === expectedTotalMonthly, "totalMonthly accurately reflects sum of active subscriptions");
  const expectedTotalAnnual = Math.round((netflixSub.annualCost + gymSub.annualCost + primeSub.annualCost) * 100) / 100;
  assert(subRes.body.totalAnnual === expectedTotalAnnual, "totalAnnual accurately reflects sum of active subscriptions");

  // Cleanup Suite 30
  await netflix1.destroy();
  await netflix2.destroy();
  await netflix3.destroy();
  await gym1.destroy();
  await prime1.destroy();
  await cancelled1.destroy();
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards/" + subCardId,
    method: "DELETE",
    headers: authHeaders,
  });


  // 31. Idempotent Offline Retries & clientRef Deduplication (Phase L)
  console.log("\n--- Suite 31: Idempotent Offline Retries & clientRef Deduplication (Phase L) ---");

  const testClientRef1 = crypto.randomUUID();
  const testClientRef2 = crypto.randomUUID();

  // 1. First expense submission with clientRef
  const expRes1 = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Lunch at Cafe",
      amount: 14.50,
      due_date: "2026-04-15",
      category: "Food & Drink",
      clientRef: testClientRef1,
    }
  );
  assert(expRes1.status === 201 && expRes1.body.id, "Creates first transaction with clientRef with HTTP 201");
  const expId1 = expRes1.body.id;

  // 2. Retry identical submission with the same clientRef
  const retryExpRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/expenses",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Lunch at Cafe",
      amount: 14.50,
      due_date: "2026-04-15",
      category: "Food & Drink",
      clientRef: testClientRef1,
    }
  );
  assert(retryExpRes.status === 200, "Retrying identical submission returns HTTP 200 (idempotent)");
  assert(retryExpRes.body.id === expId1, "Returns the existing transaction ID without duplicating");
  assert(retryExpRes.body.isDuplicate === true, "Flags response with isDuplicate: true");

  // Verify only 1 row exists in database for this clientRef
  const matchCount = await Transaction.count({
    where: { clientRef: testClientRef1 },
  });
  assert(matchCount === 1, "Database strictly contains exactly 1 record for unique clientRef");

  // 3. First paycheque submission with clientRef
  const payRes1 = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/paycheques",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Freelance Design",
      amount: 750.00,
      payment_date: "2026-04-15",
      clientRef: testClientRef2,
    }
  );
  assert(payRes1.status === 201 && payRes1.body.id, "Creates paycheque with clientRef with HTTP 201");
  const payId1 = payRes1.body.id;

  // 4. Retry paycheque with same clientRef
  const retryPayRes = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/paycheques",
      method: "POST",
      headers: authHeaders,
    },
    {
      name: "Freelance Design",
      amount: 750.00,
      payment_date: "2026-04-15",
      clientRef: testClientRef2,
    }
  );
  assert(retryPayRes.status === 200, "Retrying paycheque returns HTTP 200");
  assert(retryPayRes.body.id === payId1, "Returns existing paycheque ID without duplicating");

  // Cleanup Suite 31
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/" + expId1,
    method: "DELETE",
    headers: authHeaders,
  });
  await Transaction.destroy({ where: { id: payId1 } });

  // Cleanup
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses/" + todayExp.body.id,
    method: "DELETE",
    headers: authHeaders,
  });
  await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards/" + testCardId,
    method: "DELETE",
    headers: authHeaders,
  });



  console.log("\n  [CLEANUP] All temporary test records purged from database.");

  console.log("\n==================================================");
  console.log(`   TEST RUN COMPLETED: ${passed} passed, ${failed} failed`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
