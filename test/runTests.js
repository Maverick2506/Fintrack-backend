// The test process must never touch a remote database.
process.env.NODE_ENV = "test"; // database.js -> always local SQLite
delete process.env.USE_PRODUCTION_DB;
delete process.env.DATABASE_URL;
process.env.RELAX_RATE_LIMIT = "true";
const { Sequelize, Op } = require("sequelize");
const { sequelize, Account, Transaction, Setting, Budget, NetWorthSnapshot } = require("../models");
const { restoreBackup } = require("../scripts/restore");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { getBalancesSummary } = require("../services/netWorthService");
const { getNextOccurrenceDate, getNextDueDate } = require("../routes/recurring");
const { toZonedTime, format } = require("date-fns-tz");
const TIMEZONE = "America/Toronto";
const getTorontoToday = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", { timeZone: TIMEZONE });
const getTorontoOffsetDate = (days) => {
  const [y, m, d] = getTorontoToday().split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
};



// Hard stop safety verification for the test process itself
if (require("../database").isProductionDb) {
  console.error("❌ Test process is connected to a remote database. Aborting.");
  process.exit(1);
}

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    if (payload) {
      // Node sends a DELETE body without framing unless Content-Length is set
      options = { ...options, headers: { ...(options.headers || {}), "Content-Length": Buffer.byteLength(payload) } };
    }
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
    if (payload) {
      req.write(payload);
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
  if (healthRes.body?.environment !== "test") {
    console.error("\n❌ The server on localhost:8000 is not in test mode. Start it with NODE_ENV=test (uses test-database.sqlite) and re-run.\n");
    process.exit(1);
  }
  assert(
    healthRes.status === 200 && healthRes.body.isProductionDb === false && healthRes.body.environment === "test",
    "Target server verified running in test mode on safe test database (test-database.sqlite)"
  );
  // Reset test database to clean slate for reproducible runs
  await sequelize.sync();
  await Transaction.destroy({ where: {} });
  await Account.destroy({ where: { name: { [Op.ne]: "Primary Checking" } } });
  await Account.findOrCreate({
    where: { name: "Primary Checking" },
    defaults: { type: "CHECKING", initialBalance: 0.0 },
  });


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
  // R1 Safety Guard: Verify all registered routes reject unauthenticated requests
  const routeAuthRouters = [
    { prefix: "/api/auth", r: require("../routes/auth") },
    { prefix: "/api/export", r: require("../routes/export") },
    { prefix: "/api/cron", r: require("../routes/cron") },
    { prefix: "/api/recurring", r: require("../routes/recurring") },
    { prefix: "/api", r: require("../routes/expenses") },
    { prefix: "/api", r: require("../routes/debts") },
    { prefix: "/api", r: require("../routes/savingsGoals") },
    { prefix: "/api", r: require("../routes/dashboard") },
    { prefix: "/api", r: require("../routes/gemini") },
    { prefix: "/api", r: require("../routes/creditCards") },
    { prefix: "/api", r: require("../routes/accounts") },
    { prefix: "/api", r: require("../routes/paycheques") },
    { prefix: "/api/budgets", r: require("../routes/budgets") },
    { prefix: "/api/forecast", r: require("../routes/forecast") },
    { prefix: "/api/settings", r: require("../routes/settings") },
    { prefix: "/api/net-worth-history", r: require("../routes/netWorthHistory") },
    { prefix: "/api/subscriptions", r: require("../routes/subscriptions") },
  ];
  const publicAllowlist = [
    /^\/api\/health/,
    /^\/api\/auth\/login/,
    /^\/api\/cron/,
    /^\/api\/digest/,
    /^\/api\/daily-check/,
    /^\/api\/export/,
  ];
  for (const { prefix, r } of routeAuthRouters) {
    const stack = r.stack || [];
    for (const layer of stack) {
      if (layer.route) {
        const fullPath = (prefix === "/" ? "" : prefix) + (layer.route.path === "/" ? "" : layer.route.path);
        if (publicAllowlist.some((re) => re.test(fullPath))) continue;
        const testPath = fullPath.replace(/:[a-zA-Z_]+/g, "test-id");
        for (const m of Object.keys(layer.route.methods)) {
          const res = await request({
            hostname: "localhost",
            port: 8000,
            path: testPath,
            method: m.toUpperCase() === "_ALL" ? "GET" : m.toUpperCase(),
          });
          assert(
            res.status === 401,
            `Endpoint ${m.toUpperCase()} ${fullPath} rejects unauthenticated request with HTTP 401`
          );
        }
      }
    }
  }


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

  // Archive and delete need a $0 balance, so settle it first
  await request({ hostname: "localhost", port: 8000, path: `/api/accounts/${cardId}/final-payment`, method: "POST", headers: authHeaders }, {});
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
  // Archive and delete need a $0 balance, so settle it first
  await request({ hostname: "localhost", port: 8000, path: `/api/accounts/${testDebt.body.id}/final-payment`, method: "POST", headers: authHeaders }, {});
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
  // Archive and delete need a $0 balance, so settle it first
  await request({ hostname: "localhost", port: 8000, path: `/api/accounts/${testGoal.body.id}/final-payment`, method: "POST", headers: authHeaders }, {});
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

  // 18b. Editing a TRANSFER to target a DEBT account keeps it a TRANSFER (debt payments are transfers, C5)
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
    s18RetargetDebt.status === 200 && s18RetargetDebt.body.type === "TRANSFER",
    "Editing transfer to target a DEBT account keeps type TRANSFER"
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
  const { createRecurringExpenses } = require("../routes/recurring");

  // 19.1: Verify assertAuthConfiguration in production mode
  const origNodeEnv = process.env.NODE_ENV;
  const origPassword = process.env.SUPER_SECRET_PASSWORD;
  const origJwtSecret = process.env.JWT_SECRET;

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

    // Password set but no JWT_SECRET: production must not derive the signing key from the password (C2)
    process.env.SUPER_SECRET_PASSWORD = "test-prod-password-123";
    delete process.env.JWT_SECRET;
    let jwtMissingError = null;
    try {
      assertAuthConfiguration();
    } catch (err) {
      jwtMissingError = err;
    }
    assert(
      jwtMissingError !== null && jwtMissingError.message.includes("JWT_SECRET must be set"),
      "assertAuthConfiguration() refuses to start in production when JWT_SECRET is unset"
    );

    process.env.JWT_SECRET = "too-short";
    let jwtShortOk = true;
    try {
      assertAuthConfiguration();
    } catch (err) {
      jwtShortOk = false;
    }
    assert(jwtShortOk, "assertAuthConfiguration() only warns (does not refuse to boot) when JWT_SECRET is short");

    // With password and JWT_SECRET set in production
    process.env.JWT_SECRET = "a".repeat(48);
    let prodSuccess = true;
    try {
      assertAuthConfiguration();
    } catch (err) {
      prodSuccess = false;
    }
    assert(prodSuccess, "assertAuthConfiguration() succeeds in production when SUPER_SECRET_PASSWORD and JWT_SECRET are provided");

    // Hashed password in production (C2)
    const { hashPassword, verifyPassword } = require("../config/auth");
    delete process.env.SUPER_SECRET_PASSWORD;
    process.env.SUPER_SECRET_PASSWORD_HASH = hashPassword("hashed-prod-password");
    let hashSuccess = true;
    try {
      assertAuthConfiguration();
    } catch (err) {
      hashSuccess = false;
    }
    assert(hashSuccess, "assertAuthConfiguration() succeeds in production with SUPER_SECRET_PASSWORD_HASH and no plaintext password");
    assert(verifyPassword("hashed-prod-password") === true, "verifyPassword() accepts the password matching SUPER_SECRET_PASSWORD_HASH");
    assert(verifyPassword("wrong-password") === false, "verifyPassword() rejects a password not matching SUPER_SECRET_PASSWORD_HASH");

    process.env.SUPER_SECRET_PASSWORD_HASH = "scrypt$nothex$bad";
    let malformedError = null;
    try {
      assertAuthConfiguration();
    } catch (err) {
      malformedError = err;
    }
    assert(
      malformedError !== null && malformedError.message.includes("SUPER_SECRET_PASSWORD_HASH is malformed"),
      "assertAuthConfiguration() refuses to start in production with a malformed SUPER_SECRET_PASSWORD_HASH"
    );
  } finally {
    process.env.NODE_ENV = origNodeEnv;
    if (origPassword !== undefined) {
      process.env.SUPER_SECRET_PASSWORD = origPassword;
    } else {
      delete process.env.SUPER_SECRET_PASSWORD;
    }
    if (origJwtSecret !== undefined) {
      process.env.JWT_SECRET = origJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
    delete process.env.SUPER_SECRET_PASSWORD_HASH;
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

  const yesterdayStr = getTorontoOffsetDate(-1);
  const fiveDaysAgoStr = getTorontoOffsetDate(-5);
  const todayIso = getTorontoToday();

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
  const getOffsetDate = (days) => getTorontoOffsetDate(days);

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

  // Test Fix #4: Bill marked paid before its due date must not be deducted twice
  const day5Str = getOffsetDate(5);
  const paidEarlyBillRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/expenses",
    method: "POST",
    headers: authHeaders,
  }, {
    name: "Suite 25 Early Paid Bill",
    amount: 100,
    due_date: day5Str,
    is_paid: true,
  });
  assert(paidEarlyBillRes.status === 201, "Creates bill due on Day 5 marked paid today");

  const forecastAfterEarlyPaid = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/forecast?days=60",
    method: "GET",
    headers: authHeaders,
  });
  const day5Entry = forecastAfterEarlyPaid.body.days.find((d) => d.date === day5Str);
  const day5Titles = day5Entry ? day5Entry.items.map((it) => it.title) : [];
  assert(!day5Titles.includes("Suite 25 Early Paid Bill"), "Forecast does NOT count early-paid bill again on Day 5 due date");

  await request({ hostname: "localhost", port: 8000, path: "/api/expenses/" + paidEarlyBillRes.body.id, method: "DELETE", headers: authHeaders });

  // Clean up Suite 25 records
  await request({ hostname: "localhost", port: 8000, path: "/api/expenses/" + checkingBillRes.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/expenses/" + suite25CardChargeRes.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/credit-cards/" + phaseECardId, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/debts/" + phaseEDebtId, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + paychequeRes.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + recurringIncomeRes.body.id, method: "DELETE", headers: authHeaders });

  // --- Suite 25.1: Estimated Paycheques & Settings (Review 17 Part 2) ---
  console.log("\n--- Suite 25.1: Estimated Paycheques & Settings (Review 17 Part 2) ---");

  // 1. Setting GET /api/settings/forecast-estimate-income returns true by default
  const getEstSettingRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/settings/forecast-estimate-income",
    method: "GET",
    headers: authHeaders,
  });
  assert(getEstSettingRes.status === 200 && getEstSettingRes.body.enabled === true, "GET /api/settings/forecast-estimate-income returns true by default");

  // 2. Setting PUT /api/settings/forecast-estimate-income rejects invalid body
  const badEstSettingRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/settings/forecast-estimate-income",
    method: "PUT",
    headers: authHeaders,
  }, { enabled: "invalid" });
  assert(badEstSettingRes.status === 400, "PUT /api/settings/forecast-estimate-income rejects invalid body with HTTP 400");

  // 3. Test 1: Three one-off bi-weekly paycheques (-28, -14, +2 days) -> estimated items at +16, +30, +44, +58
  const p1Res = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Paycheque -28",
    amount: 2100,
    payment_date: getOffsetDate(-28),
  });
  const p2Res = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Paycheque -14",
    amount: 2100,
    payment_date: getOffsetDate(-14),
  });
  const p3Res = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Paycheque +2",
    amount: 2100,
    payment_date: getOffsetDate(2),
  });
  assert(p1Res.status === 201 && p2Res.status === 201 && p3Res.status === 201, "Creates 3 one-off paycheques at -28, -14, and +2 days");

  const forecastEst1Res = await request({ hostname: "localhost", port: 8000, path: "/api/forecast?days=60", method: "GET", headers: authHeaders });
  const f1 = forecastEst1Res.body;
  assert(f1.estimatedIncome !== null, "Forecast returns estimatedIncome object");
  assert(f1.estimatedIncome?.cadence === "bi-weekly", "estimatedIncome cadence is 'bi-weekly'");
  assert(f1.estimatedIncome?.amount === 2100, "estimatedIncome amount is $2100");
  assert(f1.estimatedIncome?.basedOn === 3, "estimatedIncome basedOn is 3");

  const expDates = [getOffsetDate(16), getOffsetDate(30), getOffsetDate(44), getOffsetDate(58)];
  assert(
    expDates.every((d) => f1.estimatedIncome?.dates?.includes(d)),
    "estimatedIncome dates include +16, +30, +44, and +58 days"
  );

  const day16 = f1.days.find((d) => d.date === getOffsetDate(16));
  assert(
    day16 && day16.items.some((it) => it.title === "Estimated paycheque" && it.estimated === true && it.amount === 2100),
    "Day +16 contains Estimated paycheque item with estimated: true"
  );

  // 4. Test 2: A recurring bi-weekly series -> estimatedIncome === null, no estimated items
  const recurringSeriesRes = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Recurring Paycheque Series",
    amount: 2100,
    payment_date: getOffsetDate(2),
    recurrence: "bi-weekly",
  });
  const forecastRecRes = await request({ hostname: "localhost", port: 8000, path: "/api/forecast?days=60", method: "GET", headers: authHeaders });
  assert(forecastRecRes.body.estimatedIncome === null, "Recurring bi-weekly series results in estimatedIncome === null");
  const hasAnyEstimated = forecastRecRes.body.days.some((d) => d.items.some((it) => it.estimated === true));
  assert(!hasAnyEstimated, "No days contain estimated items when recurring series exists");
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + recurringSeriesRes.body.id, method: "DELETE", headers: authHeaders });

  // 5. Test 3: A real one-off paycheque 2 days after a projected date -> that date is skipped (±3-day rule)
  const realP18Res = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Real Paycheque +18",
    amount: 2100,
    payment_date: getOffsetDate(18),
  });
  const forecastSkipRes = await request({ hostname: "localhost", port: 8000, path: "/api/forecast?days=60", method: "GET", headers: authHeaders });
  assert(!forecastSkipRes.body.estimatedIncome?.dates?.includes(getOffsetDate(16)), "+16 is skipped when real paycheque exists at +18");
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + realP18Res.body.id, method: "DELETE", headers: authHeaders });

  // 6. Test 4: forecast_estimate_income = "false" -> estimatedIncome === null
  const disableSettingRes = await request({ hostname: "localhost", port: 8000, path: "/api/settings/forecast-estimate-income", method: "PUT", headers: authHeaders }, { enabled: false });
  assert(disableSettingRes.status === 200 && disableSettingRes.body.enabled === false, "PUT /api/settings/forecast-estimate-income sets enabled to false");
  const forecastDisabledRes = await request({ hostname: "localhost", port: 8000, path: "/api/forecast?days=60", method: "GET", headers: authHeaders });
  assert(forecastDisabledRes.body.estimatedIncome === null, "When forecast_estimate_income is false, estimatedIncome is null");
  // Re-enable setting
  await request({ hostname: "localhost", port: 8000, path: "/api/settings/forecast-estimate-income", method: "PUT", headers: authHeaders }, { enabled: true });

  // Clean up the 3 one-off paycheques
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + p1Res.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + p2Res.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + p3Res.body.id, method: "DELETE", headers: authHeaders });

  // 7. Test 5: Irregular incomes (gaps of 5, 20 and 40 days) -> no estimates
  const irr1 = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Irr 1",
    amount: 1500,
    payment_date: getOffsetDate(-65),
  });
  const irr2 = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Irr 2",
    amount: 1500,
    payment_date: getOffsetDate(-25),
  });
  const irr3 = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Irr 3",
    amount: 1500,
    payment_date: getOffsetDate(-5),
  });
  const irr4 = await request({ hostname: "localhost", port: 8000, path: "/api/paycheques", method: "POST", headers: authHeaders }, {
    name: "Irr 4",
    amount: 1500,
    payment_date: getOffsetDate(0),
  });
  const forecastIrrRes = await request({ hostname: "localhost", port: 8000, path: "/api/forecast?days=60", method: "GET", headers: authHeaders });
  assert(forecastIrrRes.body.estimatedIncome === null, "Irregular income gaps result in estimatedIncome === null");
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + irr1.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + irr2.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + irr3.body.id, method: "DELETE", headers: authHeaders });
  await request({ hostname: "localhost", port: 8000, path: "/api/paycheques/" + irr4.body.id, method: "DELETE", headers: authHeaders });

  // 8. Test 6: Bills only, no income history -> unchanged from today (estimatedIncome === null)
  const forecastNoIncRes = await request({ hostname: "localhost", port: 8000, path: "/api/forecast?days=60", method: "GET", headers: authHeaders });
  assert(forecastNoIncRes.body.estimatedIncome === null, "Bills only with no income history leaves estimatedIncome === null");

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
  const d3Str = getTorontoOffsetDate(3);
  const d4Str = getTorontoOffsetDate(4);

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

  // Test Fix #5: Unknown /api/* paths return 404 without authorization token
  const unauthUnknownRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/does-not-exist-xyz",
    method: "GET",
  });
  assert(unauthUnknownRes.status === 404, "GET /api/does-not-exist-xyz without token returns HTTP 404 (not 401)");

  // Test Fix #2: Dedicated POST /api/subscriptions/:recurringGroupId/cancel
  const cancelTestGroupId = crypto.randomUUID();
  const subCancelPast = await Transaction.create({
    title: "Spotify Family",
    amount: 18.99,
    date: "2026-01-10",
    type: "EXPENSE",
    category: "Entertainment",
    recurrence: "monthly",
    isCleared: true,
    recurringGroupId: cancelTestGroupId,
    fromAccountId: subCardId,
  });
  const subCancelFutureUnpaid = await Transaction.create({
    title: "Spotify Family",
    amount: 18.99,
    date: "2026-11-10",
    type: "EXPENSE",
    category: "Entertainment",
    recurrence: "monthly",
    isCleared: false,
    recurringGroupId: cancelTestGroupId,
    fromAccountId: subCardId,
  });

  // Verify cancel endpoint
  const cancelRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/subscriptions/" + cancelTestGroupId + "/cancel",
    method: "POST",
    headers: authHeaders,
  });
  assert(cancelRes.status === 200 && cancelRes.body.success === true, "POST /api/subscriptions/:id/cancel returns HTTP 200 with success: true");
  assert(cancelRes.body.deletedRows >= 1, "Cancelling subscription deletes future unpaid occurrences");

  // Verify future unpaid was destroyed
  const checkFuture = await Transaction.findByPk(subCancelFutureUnpaid.id);
  assert(checkFuture === null, "Future unpaid occurrence successfully deleted from DB");

  // Verify historical occurrence kept recurringGroupId but recurrence is 'none'
  const checkPast = await Transaction.findByPk(subCancelPast.id);
  assert(checkPast.recurrence === "none", "Past occurrence recurrence updated to 'none'");
  assert(checkPast.recurringGroupId === cancelTestGroupId, "Past occurrence keeps its recurringGroupId intact");

  // Verify createRecurringExpenses generates no duplicate rows
  await createRecurringExpenses();
  const afterSweepOccurrences = await Transaction.findAll({
    where: { recurringGroupId: cancelTestGroupId },
  });
  assert(afterSweepOccurrences.length === 1, "Sweep does not resurrect cancelled subscription or create duplicate charges");

  // Cleanup cancel test records
  await subCancelPast.destroy();

  // Cleanup Suite 30
  await Transaction.destroy({
    where: {
      recurringGroupId: {
        [Op.in]: [netflixGroupId, gymGroupId, primeGroupId, cancelledGroupId, cancelTestGroupId],
      },
    },
  });
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




  // --- Suite 32: Gemini Integration Modernization (Phases G1 - G16) ---
  console.log("\n--- Suite 32: Gemini Integration & Modernized AI Features (Phases G1 - G16) ---");

  // 1. Health check exposes AI status (G5)
  const healthCheck = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/health",
    method: "GET",
  });
  assert(healthCheck.status === 200, "GET /api/health returns HTTP 200");
  assert(typeof healthCheck.body.ai === "boolean", "GET /api/health exposes ai boolean flag");
  assert(healthCheck.body.ai === false, "AI is reported as false when GEMINI_API_KEY is not configured");

  // 2. Missing key returns HTTP 503 instead of 500 (G5)
  const adviceNoKey = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/financial-advice",
      method: "POST",
      headers: authHeaders,
    },
    {}
  );
  assert(adviceNoKey.status === 503, "POST /api/financial-advice returns HTTP 503 when AI service is not configured");
  assert(adviceNoKey.body.error === "AI service is not configured.", "Returns clear 503 error message");

  const chatNoKey = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/chat-advisor",
      method: "POST",
      headers: authHeaders,
    },
    { message: "Can I afford $300?" }
  );
  assert(chatNoKey.status === 503, "POST /api/chat-advisor returns HTTP 503 when AI service is not configured");

  // 3. Categorize fallback without API key (G5)
  const catNoKey = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/categorize-expense",
      method: "POST",
      headers: authHeaders,
    },
    { name: "Brand New Unique Merchant XYZ" }
  );
  assert(catNoKey.status === 200, "POST /api/categorize-expense returns HTTP 200");
  assert(catNoKey.body.category === "Other", "Defaults to 'Other' when unconfigured and not in history");
  assert(catNoKey.body.source === "default", "Reports source as default");

  // 4. Input Validation & Capping via Zod (G7)
  const catEmpty = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/categorize-expense",
      method: "POST",
      headers: authHeaders,
    },
    { name: "" }
  );
  assert(catEmpty.status === 400, "POST /api/categorize-expense rejects empty name with HTTP 400");

  const catOversized = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/categorize-expense",
      method: "POST",
      headers: authHeaders,
    },
    { name: "A".repeat(101) }
  );
  assert(catOversized.status === 400, "POST /api/categorize-expense rejects name > 100 chars with HTTP 400");

  const chatEmpty = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/chat-advisor",
      method: "POST",
      headers: authHeaders,
    },
    { message: "" }
  );
  assert(chatEmpty.status === 400, "POST /api/chat-advisor rejects empty message with HTTP 400");

  const chatOversized = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/chat-advisor",
      method: "POST",
      headers: authHeaders,
    },
    { message: "A".repeat(2001) }
  );
  assert(chatOversized.status === 400, "POST /api/chat-advisor rejects message > 2000 chars with HTTP 400");

  const chatHistoryOversized = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/chat-advisor",
      method: "POST",
      headers: authHeaders,
    },
    {
      message: "Hello",
      history: Array(9).fill({ role: "user", text: "hi" }),
    }
  );
  assert(chatHistoryOversized.status === 503, "POST /api/chat-advisor gracefully trims history > 8 entries without 400 error (C1)");

  // 5. Smart History & Normalized Matching (G8)
  const pastTxRecord = await Transaction.create({
    title: "Tim Hortons",
    amount: 5.75,
    type: "EXPENSE",
    category: "Food & Drink",
    date: getTorontoToday(),
    isCleared: true,
  });

  const catHistoryMatch = await request(
    {
      hostname: "localhost",
      port: 8000,
      path: "/api/categorize-expense",
      method: "POST",
      headers: authHeaders,
    },
    { name: "Tim Hortons #4812" }
  );
  assert(catHistoryMatch.status === 200, "POST /api/categorize-expense matches normalized history");
  assert(catHistoryMatch.body.category === "Food & Drink", "Returns matched category 'Food & Drink'");
  assert(catHistoryMatch.body.source === "history", "Attributes source to history (0ms latency, zero API cost)");

  await pastTxRecord.destroy();

  // 6. Export Feed Key Hardening & Timing-Safe Check (G11)
  const configRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/gemini-config",
    method: "GET",
    headers: authHeaders,
  });
  assert(configRes.status === 200, "GET /api/export/gemini-config returns HTTP 200");
  assert(Boolean(configRes.body.feedKey), "Returns valid feedKey");

  const badFeedRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/financial-feed.csv?key=invalid_feed_key_123",
    method: "GET",
  });
  assert(badFeedRes.status === 401, "GET /api/export/financial-feed.csv rejects invalid key with HTTP 401");

  const goodFeedRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/financial-feed.csv?key=" + configRes.body.feedKey,
    method: "GET",
  });
  assert(goodFeedRes.status === 200, "GET /api/export/financial-feed.csv returns HTTP 200 with valid key");
  assert(goodFeedRes.headers["content-type"].includes("text/csv"), "Returns text/csv content type");

  const goodMdFeedRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/export/financial-feed.md?key=" + configRes.body.feedKey,
    method: "GET",
  });
  assert(goodMdFeedRes.status === 200, "GET /api/export/financial-feed.md returns HTTP 200 with valid key");
  assert(goodMdFeedRes.headers["content-type"].includes("text/markdown"), "Returns text/markdown content type");

  // 33. Code review remediation (C5, B2, B3, B6, B11, B13, B14, B15, B17, S4)
  console.log("\n--- Suite 33: Code Review Remediation ---");
  const s33 = (method, path, body = null, headers = authHeaders) =>
    request({ hostname: "localhost", port: 8000, path, method, headers }, body);
  const s33Today = getTorontoToday();
  const [s33Year, s33Month] = s33Today.split("-").map(Number);
  const s33Spending = async () => {
    const dash = await s33("GET", `/api/dashboard?year=${s33Year}&month=${s33Month}`);
    return parseFloat(dash.body.monthlySummary.totalSpending) || 0;
  };

  // C5: debt payments are TRANSFERs and do not count as spending
  const s33Debt = await s33("POST", "/api/debts", { name: "Suite 33 Loan", total_amount: 400.0, monthly_payment: 20.0, next_due_date: "2026-12-01" });
  assert(s33Debt.status === 201, "Creates Suite 33 debt");
  const s33DebtId = s33Debt.body.id;
  const s33SpendBefore = await s33Spending();
  const s33Pay = await s33("POST", `/api/debts/${s33DebtId}/pay`, { amount: 40.0 });
  assert(s33Pay.status === 200, "Pays $40 toward Suite 33 debt");
  const s33Ledger = await s33("GET", "/api/expenses/all");
  const s33PayRow = (s33Ledger.body || []).find((r) => r.name === "Payment for Suite 33 Loan");
  assert(s33PayRow && s33PayRow.type === "transfer", "Debt payment via /debts/:id/pay is stored as a TRANSFER (C5)");
  const s33SpendAfter = await s33Spending();
  assert(Math.abs(s33SpendAfter - s33SpendBefore) < 0.01, "Debt payment does not change monthly totalSpending (C5)");

  const s33LedgerPay = await s33("POST", "/api/expenses", { name: "Loan top-up", amount: 10.0, category: "Debt", targetAccountId: s33DebtId, due_date: s33Today, is_paid: true });
  assert(s33LedgerPay.status === 201 && s33LedgerPay.body.type === "TRANSFER", "Debt payment via /expenses is stored as a TRANSFER (C5)");

  // Removing the target from a debt payment turns it into ordinary spending
  const s33Unlink = await s33("PUT", `/api/expenses/${s33LedgerPay.body.id}`, { name: "Groceries", amount: 10.0, category: "Groceries", is_paid: true, targetAccountId: null });
  assert(s33Unlink.status === 200 && s33Unlink.body.type === "EXPENSE" && s33Unlink.body.toAccountId === null, "Unlinking a debt payment re-derives it as an EXPENSE");
  await s33("DELETE", `/api/expenses/${s33LedgerPay.body.id}`);

  // B6: explicit "General Debt Expense" (null target) is not re-linked by name
  const s33General = await s33("POST", "/api/expenses", { name: "Suite 33 Loan", amount: 5.0, category: "Debt", targetAccountId: null, due_date: s33Today, is_paid: true });
  assert(s33General.status === 201 && s33General.body.toAccountId === null, "Explicit null target on a Debt expense stays unlinked even when the title matches a debt (B6)");
  const s33Matched = await s33("POST", "/api/expenses", { name: "Suite 33 Loan", amount: 5.0, category: "Debt", due_date: s33Today, is_paid: true });
  assert(s33Matched.status === 201 && s33Matched.body.toAccountId === s33DebtId, "Omitted target on a Debt expense still links by exact name (quick add)");
  await s33("DELETE", `/api/expenses/${s33General.body.id}`);
  await s33("DELETE", `/api/expenses/${s33Matched.body.id}`);

  // B2: the ledger returns tax fields
  const s33Tax = await s33("POST", "/api/expenses", { name: "Suite 33 Taxed", amount: 100.0, category: "Shopping", due_date: s33Today, is_paid: true, isTaxExclusive: true, taxRate: 13 });
  assert(s33Tax.status === 201, "Creates tax-exclusive expense");
  const s33Ledger2 = await s33("GET", "/api/expenses/all");
  const s33TaxRow = (s33Ledger2.body || []).find((r) => r.id === s33Tax.body.id);
  assert(
    s33TaxRow && s33TaxRow.isTaxExclusive === true && s33TaxRow.taxRate === 13 && s33TaxRow.baseAmount === 100 && s33TaxRow.taxApplied === true,
    "/expenses/all returns isTaxExclusive, taxRate, baseAmount and taxApplied (B2)"
  );
  await s33("DELETE", `/api/expenses/${s33Tax.body.id}`);

  // B3: setting a recurring row to "none" stops the series
  const s33Series = await s33("POST", "/api/expenses", { name: "Suite 33 Streaming", amount: 15.0, category: "Entertainment", due_date: s33Today, is_paid: true, recurrence: "weekly" });
  assert(s33Series.status === 201 && s33Series.body.recurringGroupId, "Creates weekly recurring series");
  const s33GroupId = s33Series.body.recurringGroupId;
  const s33SeriesRows = await Transaction.findAll({ where: { recurringGroupId: s33GroupId }, order: [["date", "ASC"]] });
  assert(s33SeriesRows.length > 2, "Recurring generation creates future occurrences for the series");

  // Making a later (not current) occurrence one-time changes only that row
  const s33Middle = s33SeriesRows[1];
  const s33MiddleRes = await s33("PUT", `/api/expenses/${s33Middle.id}`, { recurrence: "none" });
  assert(s33MiddleRes.status === 200 && s33MiddleRes.body.seriesEnded === false, "Setting a later occurrence to none does not end the series (B3)");
  await s33("GET", "/api/recurring/trigger-recurring");
  const s33AfterMiddle = await Transaction.findAll({ where: { recurringGroupId: s33GroupId } });
  const s33MiddleAfter = s33AfterMiddle.find((t) => t.id === s33Middle.id);
  assert(
    s33AfterMiddle.length >= s33SeriesRows.length && s33MiddleAfter && s33MiddleAfter.recurrence === "none" &&
      s33AfterMiddle.filter((t) => t.date === s33Middle.date).length === 1,
    "Other occurrences are kept, the edited one stays one-time, and generation does not duplicate its date (B3)"
  );

  const s33Stop = await s33("PUT", `/api/expenses/${s33Series.body.id}`, { recurrence: "none" });
  assert(s33Stop.status === 200, "Sets the series' current row to recurrence none");
  assert(s33Stop.body.seriesEnded === true && s33Stop.body.removedUpcomingCount > 0, "Setting the current occurrence to none ends the series and reports removed rows (B3)");
  await s33("GET", "/api/recurring/trigger-recurring");
  const s33AfterStop = await Transaction.findAll({ where: { recurringGroupId: s33GroupId } });
  assert(
    s33AfterStop.length === 1 && s33AfterStop.every((t) => t.recurrence === "none"),
    "Stopping a series removes its unpaid future rows and generation does not recreate them (B3)"
  );
  await Transaction.destroy({ where: { recurringGroupId: s33GroupId } });

  // B11: upcoming bills are returned once
  const s33Dash = await s33("GET", `/api/dashboard?year=${s33Year}&month=${s33Month}`);
  assert(s33Dash.body.allUpcomingBills === undefined && Array.isArray(s33Dash.body.upcomingBills), "Dashboard returns upcomingBills once (B11)");

  // B13: missing query params are a 400, not a 500
  const s33NoQuery = await s33("GET", "/api/expenses/monthly");
  assert(s33NoQuery.status === 400, "GET /expenses/monthly without year/month returns 400 (B13)");
  const s33WithQuery = await s33("GET", `/api/expenses/monthly?year=${s33Year}&month=${s33Month}`);
  assert(s33WithQuery.status === 200 && Array.isArray(s33WithQuery.body), "GET /expenses/monthly with year/month still returns 200");

  // B14: non-UUID ids are rejected with 400
  const s33BadId = await s33("PUT", "/api/expenses/not-a-uuid", { name: "x" });
  assert(s33BadId.status === 400, "PUT /expenses/:id with a non-UUID id returns 400 (B14)");
  const s33BadDebtId = await s33("DELETE", "/api/debts/123");
  assert(s33BadDebtId.status === 400, "DELETE /debts/:id with a non-UUID id returns 400 (B14)");
  const s33BadTarget = await s33("POST", "/api/expenses", { name: "Bad target", amount: 1, targetAccountId: "abc" });
  assert(s33BadTarget.status === 400, "POST /expenses with a non-UUID targetAccountId returns 400 (B14)");

  // B15: bulk delete validates its payload
  const s33BulkBad = await s33("POST", "/api/expenses/bulk-delete", { ids: ["not-a-uuid"] });
  assert(s33BulkBad.status === 400, "Bulk delete rejects non-UUID ids (B15)");
  const s33BulkEmpty = await s33("POST", "/api/expenses/bulk-delete", { ids: [] });
  assert(s33BulkEmpty.status === 400, "Bulk delete rejects an empty id list (B15)");

  // B17: card due date must be YYYY-MM-DD
  const s33BadCard = await s33("POST", "/api/credit-cards", { name: "Suite 33 Card", creditLimit: 500, dueDate: 15 });
  assert(s33BadCard.status === 400, "Credit card dueDate as a day number is rejected (B17)");

  // S4: rejected CORS origins get 403, not 500
  const s33Cors = await s33("GET", "/api/health", null, { Origin: "https://evil.example.com" });
  assert(s33Cors.status === 403, "Requests from a disallowed CORS origin return 403 (S4)");

  await s33("DELETE", `/api/debts/${s33DebtId}`);
  await Transaction.destroy({ where: { title: "Payment for Suite 33 Loan" } });

  // 34. Post-merge review fixes (N1, N4)
  console.log("\n--- Suite 34: Post-merge Review Fixes ---");
  // Started 10 days ago so next month's date falls inside the 30-day generation horizon
  const s34Start = getTorontoOffsetDate(-10);
  const s34NextMonth = getNextOccurrenceDate(s34Start, "monthly", 1);

  // N1: a Quick Add row (with clientRef) that is later made recurring still generates
  const s34Quick = await s33("POST", "/api/expenses", {
    name: "Suite 34 Quick Gym", amount: 40, due_date: s34Start, category: "Other", is_paid: true,
    recurrence: "none", clientRef: "7d8c1c1e-3a43-4b8e-9a51-0f2b1e9f5a34",
  });
  assert(s34Quick.status === 201, "Creates a Quick Add expense with a clientRef");
  const s34QuickPut = await s33("PUT", `/api/expenses/${s34Quick.body.id}`, { recurrence: "monthly" });
  assert(s34QuickPut.status === 200, "Makes the Quick Add expense monthly");
  const s34QuickRows = await Transaction.findAll({ where: { recurringGroupId: s34QuickPut.body.recurringGroupId } });
  const s34QuickNext = s34QuickRows.find((t) => t.date === s34NextMonth);
  assert(s34QuickNext, "Next month's occurrence is generated for a series that started from Quick Add (N1)");
  assert(s34QuickNext && s34QuickNext.clientRef === null, "Generated occurrence does not copy the original clientRef (N1)");
  await Transaction.destroy({ where: { recurringGroupId: s34QuickPut.body.recurringGroupId } });

  const s34Income = await s33("POST", "/api/paycheques", {
    name: "Suite 34 Quick Income", amount: 100, payment_date: s34Start, recurrence: "none",
    clientRef: "7d8c1c1e-3a43-4b8e-9a51-0f2b1e9f5a35",
  });
  assert(s34Income.status === 201, "Creates a Quick Add income with a clientRef");
  const s34IncomePut = await s33("PUT", `/api/expenses/${s34Income.body.id}`, { recurrence: "monthly", payment_date: s34Start });
  const s34IncomeRows = await Transaction.findAll({ where: { recurringGroupId: s34IncomePut.body.recurringGroupId } });
  assert(s34IncomeRows.some((t) => t.date === s34NextMonth), "Quick Add income made monthly generates next month's paycheque (N1)");
  await Transaction.destroy({ where: { recurringGroupId: s34IncomePut.body.recurringGroupId } });

  // N4: month-end dates come back after a short month instead of drifting to the clamped day
  assert(getNextOccurrenceDate("2026-02-28", "monthly", 1, 31) === "2026-03-31", "Monthly step with anchor day 31 returns from Feb 28 to Mar 31 (N4)");
  assert(getNextOccurrenceDate("2026-01-31", "monthly", 1, 31) === "2026-02-28", "Monthly step with anchor day 31 still clamps to Feb 28 (N4)");
  assert(getNextOccurrenceDate("2028-02-29", "yearly", 1) === "2029-02-28", "Yearly step clamps Feb 29 to Feb 28");
  const { getSeriesAnchorDay } = require("../routes/recurring");
  assert(getSeriesAnchorDay(["2026-02-28", "2026-01-31"]) === 31, "A clamped month-end date keeps the series' original day (N4)");
  assert(getSeriesAnchorDay(["2026-03-15", "2026-01-31"]) === 15, "A series moved to another day keeps the new day (N4)");
  assert(getSeriesAnchorDay(["2026-03-31"]) === 31, "A single-row series uses its own day");
  assert(getSeriesAnchorDay(["2026-09-30", "2026-08-31", "2026-07-15"]) === 31, "A series moved to the 31st keeps the 31st after a 30-day month");
  assert(getSeriesAnchorDay(["2026-02-28", "2026-01-29"]) === 29, "A series on the 29th returns to the 29th after February");
  assert(getSeriesAnchorDay(["2026-04-30", "2026-03-30", "2026-02-28"]) === 30, "A series on the 30th stays on the 30th");

  // Fixed dates through the generator's todayStr option, so these checks do not depend on the run date
  const { createRecurringExpenses: s34Generate, QUICK_ADD_CATCHUP_KEY } = require("../routes/recurring");
  const s34FixedToday = "2026-03-05"; // 30-day horizon ends 2026-04-04
  const s34GroupDates = async (groupId) =>
    (await Transaction.findAll({ where: { recurringGroupId: groupId }, order: [["date", "ASC"]] })).map((t) => t.date);

  // N4 integration: a series on the 31st whose newest row was clamped to Feb 28 returns to Mar 31
  const s34RentGroup = "4b0b5f2e-6c1d-4a8e-9f3a-2d7c8e9f0a34";
  await Transaction.bulkCreate([
    { title: "Suite 34 Month End Rent", amount: 10, date: "2026-01-31", type: "EXPENSE", category: "Essentials", isCleared: true, recurrence: "monthly", recurringGroupId: s34RentGroup },
    { title: "Suite 34 Month End Rent", amount: 10, date: "2026-02-28", type: "EXPENSE", category: "Essentials", isCleared: true, recurrence: "monthly", recurringGroupId: s34RentGroup },
  ]);
  await s34Generate(null, { todayStr: s34FixedToday });
  const s34RentDates = await s34GroupDates(s34RentGroup);
  assert(s34RentDates[2] === "2026-03-31", `Month-end series generates 2026-03-31 after 2026-02-28 (N4), got ${s34RentDates[2]}`);
  await Transaction.destroy({ where: { recurringGroupId: s34RentGroup } });

  // Series moved from the 15th to the 31st keeps the 31st after a 30-day month
  const s34MovedGroup = "4b0b5f2e-6c1d-4a8e-9f3a-2d7c8e9f0a35";
  await Transaction.bulkCreate([
    { title: "Suite 34 Moved Rent", amount: 10, date: "2025-12-15", type: "EXPENSE", category: "Essentials", isCleared: true, recurrence: "monthly", recurringGroupId: s34MovedGroup },
    { title: "Suite 34 Moved Rent", amount: 10, date: "2026-01-31", type: "EXPENSE", category: "Essentials", isCleared: true, recurrence: "monthly", recurringGroupId: s34MovedGroup },
    { title: "Suite 34 Moved Rent", amount: 10, date: "2026-02-28", type: "EXPENSE", category: "Essentials", isCleared: true, recurrence: "monthly", recurringGroupId: s34MovedGroup },
  ]);
  await s34Generate(null, { todayStr: s34FixedToday });
  const s34MovedDates = await s34GroupDates(s34MovedGroup);
  assert(s34MovedDates[3] === "2026-03-31", `Series moved to the 31st generates 2026-03-31, got ${s34MovedDates[3]}`);
  await Transaction.destroy({ where: { recurringGroupId: s34MovedGroup } });

  // One-time effect of N1: a Quick Add series that never generated does not backfill months before the
  // first run after deploy (stored in a Setting); it picks up from that date instead
  const s34SavedCatchup = await Setting.findByPk(QUICK_ADD_CATCHUP_KEY);
  await Setting.upsert({ key: QUICK_ADD_CATCHUP_KEY, value: s34FixedToday });
  const s34OldGym = "4b0b5f2e-6c1d-4a8e-9f3a-2d7c8e9f0a36";
  const s34OldPay = "4b0b5f2e-6c1d-4a8e-9f3a-2d7c8e9f0a37";
  const s34Plain = "4b0b5f2e-6c1d-4a8e-9f3a-2d7c8e9f0a38";
  await Transaction.bulkCreate([
    { title: "Suite 34 Old Gym", amount: 40, date: "2026-01-13", type: "EXPENSE", category: "Other", isCleared: true, recurrence: "monthly", recurringGroupId: s34OldGym, clientRef: "7d8c1c1e-3a43-4b8e-9a51-0f2b1e9f5a36" },
    { title: "Suite 34 Old Pay", amount: 100, date: "2026-01-13", type: "INCOME", isCleared: true, recurrence: "monthly", recurringGroupId: s34OldPay, clientRef: "7d8c1c1e-3a43-4b8e-9a51-0f2b1e9f5a37" },
    { title: "Suite 34 Plain Bill", amount: 20, date: "2026-01-13", type: "EXPENSE", category: "Other", isCleared: true, recurrence: "monthly", recurringGroupId: s34Plain },
  ]);
  await s34Generate(null, { todayStr: s34FixedToday });
  const s34GymDates = await s34GroupDates(s34OldGym);
  const s34PayDates = await s34GroupDates(s34OldPay);
  assert(
    s34GymDates.join(",") === "2026-01-13,2026-03-13",
    `Quick Add expense series skips missed past months and resumes on 2026-03-13, got ${s34GymDates.join(",")}`
  );
  assert(
    s34PayDates.join(",") === "2026-01-13,2026-03-13",
    `Quick Add income series skips missed past months and resumes on 2026-03-13, got ${s34PayDates.join(",")}`
  );
  // Later runs follow the new newest row (no clientRef) and do not go back for the skipped months
  await s34Generate(null, { todayStr: "2026-03-20" });
  const s34GymLater = await s34GroupDates(s34OldGym);
  assert(
    s34GymLater.join(",") === "2026-01-13,2026-03-13,2026-04-13",
    `A later run continues the Quick Add series without backfilling, got ${s34GymLater.join(",")}`
  );
  const s34PlainDates = await s34GroupDates(s34Plain);
  assert(s34PlainDates.includes("2026-02-13"), "A series without a clientRef still fills in a missed month as before");
  await Transaction.destroy({ where: { recurringGroupId: [s34OldGym, s34OldPay, s34Plain] } });
  if (s34SavedCatchup) {
    await Setting.upsert({ key: QUICK_ADD_CATCHUP_KEY, value: s34SavedCatchup.value });
  } else {
    await Setting.destroy({ where: { key: QUICK_ADD_CATCHUP_KEY } });
  }

  // N5 call path: a new monthly expense is saved and next month's row is generated after the commit
  const s34Monthly = await s33("POST", "/api/expenses", {
    name: "Suite 34 New Monthly", amount: 12, due_date: s34Start, category: "Other", is_paid: true, recurrence: "monthly",
  });
  assert(s34Monthly.status === 201, "Creates a monthly expense (N5)");
  const s34MonthlyDates = await s34GroupDates(s34Monthly.body.recurringGroupId);
  assert(s34MonthlyDates.includes(s34NextMonth), "Next month's row is generated after the save commits (N5)");
  await Transaction.destroy({ where: { recurringGroupId: s34Monthly.body.recurringGroupId } });

  console.log("\n--- Suite 35: Simultaneous Retries With the Same clientRef ---");
  const { isClientRefConflict } = require("../services/clientRefService");
  const s35Post = (path, body) =>
    request({ hostname: "localhost", port: 8000, path, method: "POST", headers: authHeaders }, body);

  // A retry that reaches the server together with the first save: one row is
  // created and every other request gets that row back as a duplicate (not 409/500).
  let s35CleanRounds = 0;
  const s35Rounds = 5;
  for (let round = 0; round < s35Rounds; round++) {
    const ref = crypto.randomUUID();
    const body = { name: "Suite 35 Pay", amount: 100, payment_date: "2026-04-15", clientRef: ref };
    const results = await Promise.all([0, 1, 2].map(() => s35Post("/api/paycheques", body)));
    const created = results.filter((r) => r.status === 201);
    const dups = results.filter((r) => r.status === 200 && r.body.isDuplicate === true);
    const rows = await Transaction.count({ where: { clientRef: ref } });
    if (
      created.length === 1 &&
      dups.length === 2 &&
      dups.every((r) => r.body.id === created[0].body.id && r.body.name === "Suite 35 Pay") &&
      rows === 1
    ) {
      s35CleanRounds++;
    } else {
      console.error("    Suite 35 round statuses:", results.map((r) => r.status).join(", "), "rows:", rows);
    }
    await Transaction.destroy({ where: { clientRef: ref } });
  }
  assert(
    s35CleanRounds === s35Rounds,
    "Simultaneous POST /paycheques with one clientRef: one 201, the rest 200 isDuplicate with the same row"
  );

  // The expenses route runs inside a transaction. On Postgres the race loser fails on the
  // clientRef unique index; SQLite (tests) locks instead, so check the detection directly.
  const s35Ref = crypto.randomUUID();
  const s35Row = { title: "Suite 35 Coffee", amount: 4, date: "2026-04-15", type: "EXPENSE", category: "Food & Drink" };
  await Transaction.create({ ...s35Row, clientRef: s35Ref });
  let s35SqliteErr = null;
  try {
    await Transaction.create({ ...s35Row, clientRef: s35Ref });
  } catch (err) {
    s35SqliteErr = err;
  }
  await Transaction.destroy({ where: { clientRef: s35Ref } });
  assert(isClientRefConflict(s35SqliteErr), "A duplicate clientRef insert on SQLite is recognised as a clientRef conflict");
  // Shape of the error Postgres (Neon) raises for the same race, as Sequelize reports it
  const s35PgErr = Object.assign(new Error("Validation error"), {
    name: "SequelizeUniqueConstraintError",
    fields: { clientRef: s35Ref },
    parent: { code: "23505", constraint: "transactions_client_ref_unique" },
    original: { code: "23505", constraint: "transactions_client_ref_unique" },
  });
  assert(isClientRefConflict(s35PgErr), "A duplicate clientRef insert on Postgres is recognised as a clientRef conflict");
  const s35RecurringErr = Object.assign(new Error("Validation error"), {
    name: "SequelizeUniqueConstraintError",
    fields: { recurringGroupId: s35Ref, date: "2026-04-15" },
    parent: { code: "23505", constraint: "transactions_recurring_group_date_unique" },
  });
  assert(!isClientRefConflict(s35RecurringErr), "Other unique conflicts (recurring series date) are not treated as clientRef duplicates");
  assert(!isClientRefConflict(new Error("SQLITE_BUSY: database is locked")), "Non-unique errors are not treated as clientRef duplicates");

  // POST /expenses race branch, end to end. SQLite locks before two live requests reach the
  // index, so run the real route in-process and make its first lookup miss, as when the other
  // request commits between this request's lookup and its insert. The insert then fails on the
  // real clientRef unique index and the route must answer with the saved row.
  const s35Express = require("express");
  const { JWT_SECRET } = require("../config/auth");
  const { errorHandler: s35ErrorHandler } = require("../middleware/errorHandler");
  const s35App = s35Express();
  s35App.use(s35Express.json());
  s35App.use("/api", require("../routes/expenses"));
  s35App.use(s35ErrorHandler);
  const s35Server = await new Promise((resolve) => {
    const srv = s35App.listen(0, () => resolve(srv));
  });
  const s35Token = require("jsonwebtoken").sign({ user: "Maverick" }, JWT_SECRET, { expiresIn: "5m" });
  const s35RaceRef = crypto.randomUUID();
  const s35Winner = await Transaction.create({
    ...s35Row, title: "Suite 35 Race Coffee", isCleared: true, clientRef: s35RaceRef,
  });
  const s35Balances = async () =>
    JSON.stringify((await Account.findAll({ order: [["id", "ASC"]] })).map((a) => [a.id, a.initialBalance]));
  const s35BalancesBefore = await s35Balances();
  const s35OrigFindOne = Transaction.findOne;
  let s35LookupMissed = false;
  Transaction.findOne = function (opts, ...rest) {
    if (!s35LookupMissed && opts && opts.where && opts.where.clientRef === s35RaceRef && opts.transaction) {
      s35LookupMissed = true;
      return Promise.resolve(null);
    }
    return s35OrigFindOne.call(this, opts, ...rest);
  };
  let s35Race;
  try {
    s35Race = await request(
      {
        hostname: "localhost",
        port: s35Server.address().port,
        path: "/api/expenses",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s35Token}` },
      },
      { name: "Suite 35 Race Coffee", amount: 4, due_date: "2026-04-15", category: "Food & Drink", is_paid: true, applyToBalance: true, clientRef: s35RaceRef }
    );
  } finally {
    Transaction.findOne = s35OrigFindOne;
    await new Promise((resolve) => s35Server.close(resolve));
  }
  assert(s35LookupMissed, "Race test reached the POST /expenses clientRef lookup");
  assert(
    s35Race.status === 200 && s35Race.body.isDuplicate === true && s35Race.body.id === s35Winner.id,
    `POST /expenses that loses the clientRef race returns the saved row with 200 isDuplicate (got ${s35Race.status})`
  );
  assert((await Transaction.count({ where: { clientRef: s35RaceRef } })) === 1, "Losing the clientRef race stores no second row");
  assert((await s35Balances()) === s35BalancesBefore, "Losing the clientRef race changes no account balance");
  await Transaction.destroy({ where: { clientRef: s35RaceRef } });

  // 36. Gemini Gem feed v2: forecast, paid-only recent rows, accounts, payees, monthly categories
  console.log("\n--- Suite 36: Gemini Gem Feed v2 ---");
  const { normalizePayeeTitle } = require("../utils/payeeNormalizer");
  const s36 = (path, headers = {}) => request({ hostname: "localhost", port: 8000, path, method: "GET", headers });
  // Small CSV parser (quoted fields, doubled quotes) for reading the feed back
  const s36ParseCsv = (text) =>
    text.split("\n").map((line) => {
      const out = [];
      let cur = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    });

  // Maverick's rule: drop dates and reference numbers, keep digits that belong to the name
  const s36NormCases = [
    ["7-Eleven #2231", "7-eleven"],
    ["Hydro Oct", "hydro"],
    ["hydro", "hydro"],
    [" HYDRO 10/15 ", "hydro"],
    ["Hydro Oct 22", "hydro"],
    ["COSTCO WHOLESALE 1234", "costco wholesale"],
    ["99 Ranch Market", "99 ranch market"],
    ["Rent 2026-10-01", "rent"],
    ["Netflix.com", "netflix.com"],
    ["3M", "3m"],
    ["A&W", "a&w"],
    ["POS 000123 Tim Hortons", "pos tim hortons"],
    ["Store #4521 Walmart", "store walmart"],
    ["Gym no. 12", "gym"],
    ["Visa ref 88912", "visa"],
    ["No Frills", "no frills"],
    ["Bell Sept. bill", "bell bill"],
    ["Café Nero", "cafe nero"],
    ["Marché Jean-Talon", "marche jean-talon"],
  ];
  const s36NormWrong = s36NormCases.filter(([raw, want]) => normalizePayeeTitle(raw) !== want);
  assert(
    s36NormWrong.length === 0,
    `Payee titles drop dates and reference numbers but keep digits in names (wrong: ${
      s36NormWrong.map(([raw, want]) => `${raw} -> ${normalizePayeeTitle(raw)} (want ${want})`).join("; ") || "none"
    })`
  );

  const s36Today = getTorontoToday();
  const s36Card = await Account.create({ name: "Suite 36 Visa", type: "CREDIT_CARD", initialBalance: 0, creditLimit: 1000 });
  const s36Rows = await Transaction.bulkCreate([
    { title: "Hydro Oct", amount: 80, date: getTorontoOffsetDate(-10), type: "EXPENSE", category: "Essentials", isCleared: true },
    { title: "hydro", amount: 70, date: getTorontoOffsetDate(-40), type: "EXPENSE", category: "Essentials", isCleared: true },
    { title: "Suite 36 Unpaid Past", amount: 33, date: getTorontoOffsetDate(-2), type: "EXPENSE", category: "Other", isCleared: false },
    { title: "Suite 36 Future Paid", amount: 44, date: getTorontoOffsetDate(3), type: "EXPENSE", category: "Other", isCleared: true },
    // Gives checking money so SAFE_TO_SPEND is a real number, not the 0 floor
    { title: "Suite 36 Pay", amount: 5000, date: s36Today, type: "INCOME", category: "Income", isCleared: true },
    // A card payment whose card was deleted (toAccountId set to NULL by the FK)
    { title: "Payment for Suite 36 Gone Card", amount: 61, date: getTorontoOffsetDate(-1), type: "TRANSFER", category: "Debt", isCleared: true, toAccountId: null },
    { title: "Suite 36 Upcoming Bill", amount: 55, date: getTorontoOffsetDate(5), type: "EXPENSE", category: "Essentials", isCleared: false },
  ]);
  // Created last, dated today: first row of RECENT_TRANSACTIONS
  const s36CardRow = await Transaction.create({
    title: "Suite 36 Card Lunch", amount: 12.5, date: s36Today, type: "EXPENSE", category: "Food & Drink",
    isCleared: true, fromAccountId: s36Card.id,
  });

  const s36Config = await s36("/api/export/gemini-config", authHeaders);
  const s36Key = s36Config.body.feedKey;
  const [s36CsvRes, s36MdRes, s36ForecastRes] = await Promise.all([
    s36(`/api/export/financial-feed.csv?key=${s36Key}`),
    s36(`/api/export/financial-feed.md?key=${s36Key}`),
    s36("/api/forecast", authHeaders),
  ]);
  assert(s36CsvRes.status === 200 && s36MdRes.status === 200 && s36ForecastRes.status === 200, "Feed (CSV, MD) and GET /forecast return HTTP 200");
  const s36Csv = s36ParseCsv(s36CsvRes.raw);
  const s36Section = (name) => s36Csv.filter((r) => r[0] === name);

  assert(
    s36Csv[0][0] === "SNAPSHOT_AT" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s36Csv[0][1]) && s36Csv[0][1].startsWith(s36Today),
    `CSV first row is SNAPSHOT_AT with today's Toronto date and time (got ${s36Csv[0].join(",")})`
  );
  const s36Sections = ["FORECAST", "OVERVIEW", "ACCOUNTS", "UPCOMING_BILLS", "RECENT_TRANSACTIONS", "PAYEES", "MONTHLY_CATEGORIES"];
  const s36Missing = s36Sections.filter((name) => s36Section(name).length === 0);
  assert(s36Missing.length === 0, `CSV feed has every section (missing: ${s36Missing.join(", ") || "none"})`);
  const s36MdMissing = ["Forecast", "Executive Summary", "Accounts & Liabilities", "Upcoming Unpaid Bills", "Recent Transactions", "Payees", "Monthly Categories"]
    .filter((h) => !new RegExp(`^## (\\d+\\. )?${h}`, "m").test(s36MdRes.raw));
  assert(s36MdMissing.length === 0, `Markdown feed has every section (missing: ${s36MdMissing.join(", ") || "none"})`);

  const s36Forecast = Object.fromEntries(s36Section("FORECAST").map((r) => [r[1], r[2]]));
  const s36Metrics = ["SAFE_TO_SPEND", "UNTIL", "BUFFER", "LOWEST_BALANCE", "LOWEST_DATE", "NEXT_PAYDAY", "ESTIMATED_INCOME_INCLUDED"];
  assert(s36Metrics.every((m) => m in s36Forecast), "FORECAST section has every metric");
  const s36Api = s36ForecastRes.body;
  assert(
    s36Api.safeToSpend > 0 && parseFloat(s36Forecast.SAFE_TO_SPEND) === s36Api.safeToSpend,
    `CSV SAFE_TO_SPEND equals GET /forecast safeToSpend (${s36Forecast.SAFE_TO_SPEND} vs ${s36Api.safeToSpend})`
  );
  assert(
    s36MdRes.raw.includes(`**SAFE_TO_SPEND:** **$${s36Api.safeToSpend.toFixed(2)}**`),
    "Markdown SAFE_TO_SPEND equals GET /forecast safeToSpend"
  );
  assert(
    parseFloat(s36Forecast.BUFFER) === s36Api.buffer &&
      parseFloat(s36Forecast.LOWEST_BALANCE) === s36Api.lowestPoint.balance &&
      s36Forecast.LOWEST_DATE === s36Api.lowestPoint.date &&
      s36Forecast.NEXT_PAYDAY === (s36Api.nextPayday || "") &&
      s36Forecast.ESTIMATED_INCOME_INCLUDED === (s36Api.estimatedIncome ? "YES" : "NO"),
    "FORECAST BUFFER, LOWEST_BALANCE, LOWEST_DATE, NEXT_PAYDAY, ESTIMATED_INCOME_INCLUDED match GET /forecast"
  );

  const s36RecentHeader = s36Csv.find((r) => r[0] === "SECTION" && r[1] === "DATE" && r[2] === "TYPE");
  const s36Recent = s36Section("RECENT_TRANSACTIONS");
  const s36RecentIds = s36Recent.map((r) => r[4]);
  const s36RecentDb = await Transaction.findAll({ where: { title: { [Op.in]: s36RecentIds } }, attributes: ["title", "amount", "isCleared", "date"] });
  const s36RecentPaid = s36Recent.every((r) =>
    s36RecentDb.some((t) => t.title === r[4] && t.date === r[1] && parseFloat(t.amount).toFixed(2) === r[5] && t.isCleared === true)
  );
  assert(
    s36Recent.length > 0 && s36Recent.length <= 50 && s36Recent.every((r) => r[1] <= s36Today) && s36RecentPaid,
    `RECENT_TRANSACTIONS has at most 50 rows, all paid and dated today or earlier (${s36Recent.length} rows)`
  );
  assert(
    !s36RecentIds.includes("Suite 36 Unpaid Past") && !s36RecentIds.includes("Suite 36 Future Paid") &&
      !s36RecentIds.includes("Suite 36 Upcoming Bill"),
    "RECENT_TRANSACTIONS leaves out unpaid rows and rows dated after today"
  );
  assert(s36Section("UPCOMING_BILLS").some((r) => r[2] === "Suite 36 Upcoming Bill"), "Upcoming bills stay in their own UPCOMING_BILLS section");
  assert(
    s36RecentHeader && s36RecentHeader[6] === "ACCOUNT" &&
      s36Recent[0][4] === "Suite 36 Card Lunch" && s36Recent[0][6] === "Suite 36 Visa",
    `RECENT_TRANSACTIONS has an ACCOUNT column naming the card (got ${s36Recent[0] && s36Recent[0].join(",")})`
  );
  const s36HydroRecent = s36Recent.find((r) => r[4] === "Hydro Oct");
  assert(s36HydroRecent && s36HydroRecent[6] === "Primary Checking", "ACCOUNT is the checking account for a checking expense");
  assert(s36MdRes.raw.includes("| Suite 36 Card Lunch | $12.50 | Suite 36 Visa |"), "Markdown recent ledger shows the ACCOUNT");
  const s36Gone = s36Recent.find((r) => r[4] === "Payment for Suite 36 Gone Card");
  assert(
    s36Gone && s36Gone[6] === "Primary Checking → Suite 36 Gone Card (deleted)",
    `A transfer to a deleted card names the card as deleted, not checking (got ${s36Gone && s36Gone[6]})`
  );

  const s36Payees = s36Section("PAYEES");
  const s36PayeeHeader = s36Csv.find((r) => r[0] === "SECTION" && r[1] === "TITLE");
  assert(
    s36PayeeHeader && s36PayeeHeader.slice(1).join(",") === "TITLE,CATEGORY,ACCOUNT,LAST_PAID_DATE,LAST_AMOUNT,TIMES_12M,TOTAL_12M,TOTAL_YTD",
    "PAYEES has the TITLE, CATEGORY, ACCOUNT, LAST_PAID_DATE, LAST_AMOUNT, TIMES_12M, TOTAL_12M, TOTAL_YTD columns"
  );
  const s36Hydro = s36Payees.find((r) => r[1] === "hydro");
  assert(
    s36Hydro && s36Hydro[2] === "Essentials" && s36Hydro[3] === "Primary Checking" &&
      s36Hydro[4] === getTorontoOffsetDate(-10) && s36Hydro[5] === "80.00" && s36Hydro[6] === "2" && s36Hydro[7] === "150.00" &&
      !s36Payees.some((r) => r[1] === "hydro oct"),
    `PAYEES groups "Hydro Oct" with "hydro" on one row (got ${s36Hydro && s36Hydro.join(",")})`
  );
  const s36Ytd = [getTorontoOffsetDate(-10), getTorontoOffsetDate(-40)]
    .filter((dt) => dt >= `${s36Today.slice(0, 4)}-01-01`)
    .reduce((sum, dt) => sum + (dt === getTorontoOffsetDate(-10) ? 80 : 70), 0);
  assert(s36Hydro && parseFloat(s36Hydro[8]) === s36Ytd, `PAYEES TOTAL_YTD counts this year only (${s36Hydro && s36Hydro[8]} vs ${s36Ytd})`);
  const s36Totals = s36Payees.map((r) => parseFloat(r[7]));
  assert(
    s36Payees.length <= 300 && s36Totals.every((v, i) => i === 0 || s36Totals[i - 1] >= v) &&
      !s36Payees.some((r) => r[1].includes("unpaid past") || r[1].includes("future paid")),
    "PAYEES is capped at 300, ordered by TOTAL_12M, and counts only paid rows up to today"
  );

  const s36Monthly = s36Section("MONTHLY_CATEGORIES");
  const s36Months = [...new Set(s36Monthly.map((r) => r[1]))];
  assert(s36Months.length === 12 && s36Months[0] === s36Today.slice(0, 7), `MONTHLY_CATEGORIES covers the last 12 months, newest first (got ${s36Months.length})`);
  const s36HydroMonth = getTorontoOffsetDate(-10).slice(0, 7);
  const [s36My, s36Mm] = s36HydroMonth.split("-").map(Number);
  const s36MonthEnd = `${s36HydroMonth}-${String(new Date(s36My, s36Mm, 0).getDate()).padStart(2, "0")}`;
  const s36EssentialsSpent = await Transaction.sum("amount", {
    where: { type: "EXPENSE", isCleared: true, category: "Essentials", date: { [Op.between]: [`${s36HydroMonth}-01`, s36MonthEnd < s36Today ? s36MonthEnd : s36Today] } },
  });
  const s36EssRow = s36Monthly.find((r) => r[1] === s36HydroMonth && r[2] === "Essentials");
  const s36EssBudget = await Budget.findOne({ where: { category: "Essentials" } });
  assert(
    s36EssRow && parseFloat(s36EssRow[3]) === Math.round((s36EssentialsSpent || 0) * 100) / 100 &&
      s36EssRow[4] === (s36EssBudget ? parseFloat(s36EssBudget.monthlyLimit).toFixed(2) : ""),
    `MONTHLY_CATEGORIES SPENT and BUDGET match the database (got ${s36EssRow && s36EssRow.join(",")})`
  );

  const s36Instr = s36Config.body.instructions || "";
  assert(
    s36Instr.includes("SAFE_TO_SPEND") && s36Instr.includes("NEVER compute") && !s36Instr.includes("Determine the remaining Safe Liquid Float"),
    "Gem instructions use SAFE_TO_SPEND for affordability and never compute it"
  );
  assert(
    s36Instr.includes("PAYEES") && s36Instr.includes("MONTHLY_CATEGORIES") && s36Instr.includes("say so") && s36Instr.includes("Data as of"),
    "Gem instructions cover history questions and stale data"
  );
  assert(
    s36Instr.includes("https://fintrack-frontend-jet.vercel.app/quick?text=") && s36Instr.includes("NEVER say or imply that something was saved"),
    "Gem instructions answer add/record/log with a Quick Add link and never claim a save"
  );
  assert(
    s36Instr.includes("as %2B") && s36Instr.includes("/quick?text=23.40%20lunch%20visa%0A%2B2100%20paycheque"),
    "Gem instructions encode the income + as %2B and show an income item in the link example"
  );
  const s36Script = s36Config.body.appsScript || "";
  assert(
    s36Script.includes("function installTrigger()") && s36Script.includes("everyHours(1)") &&
      s36Script.includes("deleteTrigger") && s36Script.includes("function onOpen()"),
    "Apps Script has installTrigger (hourly, removes duplicates) and keeps onOpen"
  );
  assert(
    s36Script.includes('getSheetByName("FinTrack") || ss.insertSheet("FinTrack")') && !s36Script.includes("getSheets()[0]"),
    "Apps Script writes to its own FinTrack tab, not whichever tab is first"
  );
  assert(
    !s36CsvRes.raw.includes("Expected on: None") && s36CsvRes.raw.includes("For the next payday use FORECAST NEXT_PAYDAY"),
    "OVERVIEW income projection is labelled context only and points to FORECAST NEXT_PAYDAY"
  );

  await Transaction.destroy({ where: { id: [...s36Rows.map((t) => t.id), s36CardRow.id] } });
  await s36Card.destroy();

  // 37. Safe archive and delete for cards, debts and goals
  console.log("\n--- Suite 37: Safe Archive and Delete for Cards, Debts and Goals ---");
  const { createRecurringExpenses: s37Generate } = require("../routes/recurring");
  const { getPrimaryCheckingAccount: s37GetChecking } = require("../services/checkingService");
  const s37Checking = await s37GetChecking();
  const s37Past = getTorontoOffsetDate(-10);
  const s37NextMonth = getNextOccurrenceDate(s37Past, "monthly", 1);
  const s37Soon = getTorontoOffsetDate(5);
  const s37ForecastTitles = async () => {
    const f = await s33("GET", "/api/forecast?days=60");
    return (f.body.days || []).flatMap((d) => (d.items || []).map((i) => i.title));
  };
  const s37UpcomingTitles = async () => {
    const dash = await s33("GET", "/api/dashboard");
    return (dash.body.upcomingBills || []).map((b) => b.title);
  };

  // 37.1 Archive a card that has a monthly Netflix charge and an upcoming payment, then run the generator
  const s37Card = await s33("POST", "/api/credit-cards", { name: "Suite 37 Visa", creditLimit: 1000, currentBalance: 0 });
  assert(s37Card.status === 201, "Creates Suite 37 card");
  const s37CardId = s37Card.body.id;
  const s37NetflixGroup = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a46";
  await Transaction.bulkCreate([
    { title: "Suite 37 Netflix", amount: 17, date: s37Past, type: "EXPENSE", category: "Entertainment", isCleared: true, recurrence: "monthly", recurringGroupId: s37NetflixGroup, fromAccountId: s37CardId },
    { title: "Suite 37 Netflix", amount: 17, date: s37NextMonth, type: "EXPENSE", category: "Entertainment", isCleared: false, recurrence: "monthly", recurringGroupId: s37NetflixGroup, fromAccountId: s37CardId },
    { title: "Payment for Suite 37 Visa", amount: 50, date: s37Soon, type: "TRANSFER", category: "Credit Card Payment", isCleared: false, fromAccountId: s37Checking.id, toAccountId: s37CardId },
  ]);
  assert((await s37ForecastTitles()).includes("Payment for Suite 37 Visa"), "Before archiving, the forecast includes the card's upcoming payment");

  const s37Impact = await s33("GET", `/api/accounts/${s37CardId}/delete-impact`);
  assert(
    s37Impact.status === 200 &&
      s37Impact.body.unpaid?.count === 2 &&
      s37Impact.body.unpaid?.total === 67 &&
      s37Impact.body.unpaid?.titles.includes("Suite 37 Netflix") &&
      s37Impact.body.unpaid?.titles.includes("Payment for Suite 37 Visa"),
    `delete-impact lists the card's 2 unpaid rows totalling $67 (got ${s37Impact.status} ${JSON.stringify(s37Impact.body.unpaid)})`
  );
  assert(
    s37Impact.status === 200 &&
      s37Impact.body.series?.length === 1 &&
      s37Impact.body.series[0].recurringGroupId === s37NetflixGroup &&
      s37Impact.body.series[0].title === "Suite 37 Netflix" &&
      s37Impact.body.series[0].recurrence === "monthly",
    "delete-impact lists Netflix as the card's active monthly series"
  );
  assert(s37Impact.status === 200 && s37Impact.body.balance === 0, "delete-impact returns the card balance");
  assert(
    s37Impact.status === 200 &&
      s37Impact.body.unpaid.items.find((i) => i.title === "Suite 37 Netflix")?.movable === true &&
      s37Impact.body.unpaid.items.find((i) => i.title === "Payment for Suite 37 Visa")?.movable === false,
    "delete-impact marks the card charge as movable to Checking and the payment to the card as not"
  );
  const s37ImpactBad = await s33("GET", "/api/accounts/not-a-uuid/delete-impact");
  assert(s37ImpactBad.status === 400, "delete-impact rejects a non-UUID id with 400");
  const s37ImpactChecking = await s33("GET", `/api/accounts/${s37Checking.id}/delete-impact`);
  assert(s37ImpactChecking.status === 404, "delete-impact refuses Primary Checking (404)");

  const s37BadBody = await s33("DELETE", `/api/credit-cards/${s37CardId}`, { mode: "shred" });
  assert(s37BadBody.status === 400, `DELETE rejects an unknown mode with 400 (got ${s37BadBody.status})`);
  assert((await Account.findByPk(s37CardId))?.isActive !== false, "A rejected DELETE leaves the card untouched");

  const s37Archive = await s33("DELETE", `/api/credit-cards/${s37CardId}`, { mode: "archive", series: "end" });
  assert(s37Archive.status === 204, "Archives the card (204)");
  const s37CardAfter = await Account.findByPk(s37CardId);
  assert(s37CardAfter && s37CardAfter.isActive === false, "Archive keeps the card as inactive");
  const s37NetflixRows = await Transaction.findAll({ where: { recurringGroupId: s37NetflixGroup } });
  assert(
    s37NetflixRows.length === 1 && s37NetflixRows[0].date === s37Past && s37NetflixRows[0].fromAccountId === s37CardId,
    "Archive removes the upcoming Netflix charge and keeps the paid one linked to the card"
  );
  assert(
    (await Transaction.count({ where: { title: "Payment for Suite 37 Visa" } })) === 0,
    "Archive removes the upcoming payment for the card"
  );
  await s37Generate();
  assert(
    (await Transaction.count({ where: { recurringGroupId: s37NetflixGroup } })) === 1,
    "The recurring generator does not bring Netflix back after the card is archived"
  );
  const s37Cards = await s33("GET", "/api/credit-cards");
  assert(!(s37Cards.body || []).some((c) => c.id === s37CardId), "Archived card is left out of the card list (pickers)");
  assert(!(await s37ForecastTitles()).some((t) => t.includes("Suite 37")), "Archived card's rows are left out of the forecast");
  assert(!(await s37UpcomingTitles()).some((t) => t.includes("Suite 37")), "Archived card's rows are left out of Upcoming Bills");
  const s37Ledger = await s33("GET", "/api/expenses/all");
  const s37LedgerRow = (s37Ledger.body || []).find((r) => r.recurringGroupId === s37NetflixGroup);
  assert(
    s37LedgerRow && s37LedgerRow.fromAccount === "Suite 37 Visa" && s37LedgerRow.fromAccountArchived === true,
    "The Ledger still shows the archived card's name on its past rows"
  );

  // 37.2 Move a card's recurring charges to Checking
  const s37Card2 = await s33("POST", "/api/credit-cards", { name: "Suite 37 Amex", creditLimit: 1000, currentBalance: 0 });
  const s37Card2Id = s37Card2.body.id;
  const s37SpotifyGroup = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a47";
  const s37GymGroup = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a48";
  const s37GymPast = getTorontoOffsetDate(-30);
  const s37GymNext = getNextOccurrenceDate(s37GymPast, "yearly", 1);
  await Transaction.bulkCreate([
    { title: "Suite 37 Spotify", amount: 12, date: s37Past, type: "EXPENSE", category: "Entertainment", isCleared: true, recurrence: "monthly", recurringGroupId: s37SpotifyGroup, fromAccountId: s37Card2Id },
    { title: "Suite 37 Spotify", amount: 12, date: s37NextMonth, type: "EXPENSE", category: "Entertainment", isCleared: false, recurrence: "monthly", recurringGroupId: s37SpotifyGroup, fromAccountId: s37Card2Id },
    { title: "Suite 37 Gym", amount: 300, date: s37GymPast, type: "EXPENSE", category: "Other", isCleared: true, recurrence: "yearly", recurringGroupId: s37GymGroup, fromAccountId: s37Card2Id },
    { title: "Payment for Suite 37 Amex", amount: 40, date: s37Soon, type: "TRANSFER", category: "Credit Card Payment", isCleared: false, fromAccountId: s37Checking.id, toAccountId: s37Card2Id },
  ]);
  const s37Move = await s33("DELETE", `/api/credit-cards/${s37Card2Id}`, { mode: "archive", series: "moveToChecking" });
  assert(s37Move.status === 204, "Archives the second card, moving its series to Checking");
  const s37SpotifyNext = await Transaction.findOne({ where: { recurringGroupId: s37SpotifyGroup, date: s37NextMonth } });
  assert(
    s37SpotifyNext && s37SpotifyNext.fromAccountId === s37Checking.id && s37SpotifyNext.isCleared === false,
    "moveToChecking moves the upcoming Spotify charge to Checking"
  );
  const s37GymNextRow = await Transaction.findOne({ where: { recurringGroupId: s37GymGroup, date: s37GymNext } });
  assert(
    s37GymNextRow && s37GymNextRow.fromAccountId === s37Checking.id && s37GymNextRow.isCleared === false,
    "moveToChecking starts a series with no upcoming row (yearly gym) on Checking"
  );
  assert(
    (await Transaction.count({ where: { title: "Payment for Suite 37 Amex" } })) === 0,
    "moveToChecking still ends the upcoming payment to the archived card"
  );
  const s37SpotifyPaid = await Transaction.findOne({ where: { recurringGroupId: s37SpotifyGroup, date: s37Past } });
  assert(s37SpotifyPaid && s37SpotifyPaid.fromAccountId === s37Card2Id, "Paid Spotify history stays on the archived card");
  await s37Generate(null, { todayStr: getTorontoOffsetDate(30) });
  const s37SpotifyRows = await Transaction.findAll({ where: { recurringGroupId: s37SpotifyGroup }, order: [["date", "ASC"]] });
  const s37SpotifyNewest = s37SpotifyRows[s37SpotifyRows.length - 1];
  assert(
    s37SpotifyRows.length >= 3 && s37SpotifyNewest.fromAccountId === s37Checking.id,
    `The generator keeps Spotify going on Checking (${s37SpotifyRows.length} rows)`
  );
  const s37Upcoming2 = await s33("GET", "/api/dashboard");
  const s37SpotifyBill = (s37Upcoming2.body.upcomingBills || []).find((b) => b.title === "Suite 37 Spotify");
  assert(!s37SpotifyBill || s37SpotifyBill.fromAccount?.type === "CHECKING", "A moved Spotify bill shows as paid from Checking");

  // 37.3 Delete a goal that holds money, moving it back to Checking: net worth is unchanged
  const s37Goal = await s33("POST", "/api/savings-goals", { name: "Suite 37 Trip", target_amount: 1000 });
  const s37GoalId = s37Goal.body.id;
  const s37Contrib = await s33("POST", `/api/savings-goals/${s37GoalId}/contribute`, { amount: 300 });
  assert(s37Contrib.status === 200, "Contributes $300 from Checking to the goal");
  const s37GoalImpact = await s33("GET", `/api/accounts/${s37GoalId}/delete-impact`);
  assert(s37GoalImpact.body.balance === 300, "delete-impact returns the goal's $300 balance");
  const s37NetBefore = (await getBalancesSummary()).netWorth;
  const s37CheckingBefore = (await getBalancesSummary()).checking;
  const s37GoalDelete = await s33("DELETE", `/api/savings-goals/${s37GoalId}`, { mode: "delete", series: "end", moveBalanceToChecking: true });
  assert(s37GoalDelete.status === 204, "Deletes the goal permanently, moving its money to Checking");
  assert((await Account.findByPk(s37GoalId)) === null, "The deleted goal is gone");
  const s37After = await getBalancesSummary();
  assert(
    s37After.netWorth === s37NetBefore,
    `Net worth is unchanged after deleting a goal with moveBalanceToChecking (${s37NetBefore} -> ${s37After.netWorth})`
  );
  assert(Math.round((s37After.checking - s37CheckingBefore) * 100) / 100 === 300, "Checking gains the goal's $300");
  const s37MoveRow = await Transaction.findOne({ where: { title: "Moved from Suite 37 Trip" } });
  assert(
    s37MoveRow && s37MoveRow.type === "TRANSFER" && s37MoveRow.isCleared === true && parseFloat(s37MoveRow.amount) === 300 && s37MoveRow.toAccountId === s37Checking.id,
    "One cleared $300 TRANSFER from the goal to Checking is recorded"
  );

  // Archive variant: the goal keeps its history but is emptied into Checking
  const s37Goal2 = await s33("POST", "/api/savings-goals", { name: "Suite 37 Car", target_amount: 1000 });
  const s37Goal2Id = s37Goal2.body.id;
  await s33("POST", `/api/savings-goals/${s37Goal2Id}/contribute`, { amount: 120 });
  const s37Net2Before = (await getBalancesSummary()).netWorth;
  const s37Goal2Archive = await s33("DELETE", `/api/savings-goals/${s37Goal2Id}`, { moveBalanceToChecking: true });
  assert(s37Goal2Archive.status === 204, "Archives the second goal (default mode) moving its money");
  const s37Goal2After = await Account.findByPk(s37Goal2Id);
  assert(
    s37Goal2After && s37Goal2After.isActive === false && parseFloat(s37Goal2After.initialBalance) === 0,
    "The archived goal is inactive and empty"
  );
  assert((await getBalancesSummary()).netWorth === s37Net2Before, "Net worth is unchanged after archiving a goal with moveBalanceToChecking");

  // 37.4 An archived account and any unpaid row still pointing at it stay out of the forecast, dashboard, feed and AI context
  const s37Card3 = await s33("POST", "/api/credit-cards", { name: "Suite 37 Hidden Card", creditLimit: 500, currentBalance: 80 });
  const s37Card3Id = s37Card3.body.id;
  await Transaction.create({ title: "Suite 37 Leftover Bill", amount: 80, date: s37Soon, type: "TRANSFER", category: "Credit Card Payment", isCleared: false, fromAccountId: s37Checking.id, toAccountId: s37Card3Id });
  await Account.update({ isActive: false }, { where: { id: s37Card3Id } });
  assert(!(await s37ForecastTitles()).includes("Suite 37 Leftover Bill"), "Forecast skips a row that uses an archived account");
  const s37Dash = await s33("GET", "/api/dashboard");
  assert(
    !(s37Dash.body.upcomingBills || []).some((b) => b.title === "Suite 37 Leftover Bill") &&
      !(s37Dash.body.creditCardSummary || []).some((c) => c.id === s37Card3Id),
    "Dashboard leaves out the archived card and its upcoming payment"
  );
  const s37Config = await s33("GET", "/api/export/gemini-config");
  const s37Feed = await request({ hostname: "localhost", port: 8000, path: `/api/export/financial-feed.md?key=${s37Config.body.feedKey}`, method: "GET" });
  assert(s37Feed.status === 200 && !s37Feed.raw.includes("Suite 37 Hidden Card"), "Export feed leaves out the archived card");
  const { getContextAccounts: s37ContextAccounts } = require("../routes/gemini");
  const s37Ctx =
    typeof s37ContextAccounts === "function"
      ? s37ContextAccounts([
          { type: "CREDIT_CARD", name: "On", isActive: true },
          { type: "CREDIT_CARD", name: "Off", isActive: false },
          { type: "SAVINGS_GOAL", name: "Goal Off", isActive: false, initialBalance: 5 },
          { type: "DEBT", name: "Debt Off", isActive: false, initialBalance: 5 },
        ])
      : null;
  assert(
    s37Ctx && s37Ctx.cards.map((c) => c.name).join() === "On" && s37Ctx.goals.length === 0 && s37Ctx.debts.length === 0,
    "Gemini context leaves out archived cards, goals and debts (R7)"
  );

  // 37.5 A debt with money owed cannot be archived until a final payment brings it to $0
  const s37Debt = await s33("POST", "/api/debts", { name: "Suite 37 Loan", total_amount: 500, monthly_payment: 50 });
  const s37DebtId = s37Debt.body.id;
  const s37DebtPay = await s33("POST", `/api/debts/${s37DebtId}/pay`, { amount: 50 });
  assert(s37DebtPay.status === 200, "Pays $50 toward the Suite 37 debt");
  await Transaction.create({ title: "Payment for Suite 37 Loan", amount: 50, date: s37Soon, type: "TRANSFER", category: "Debt", isCleared: false, recurrence: "monthly", fromAccountId: s37Checking.id, toAccountId: s37DebtId });
  const s37DebtImpact = await s33("GET", `/api/accounts/${s37DebtId}/delete-impact`);
  assert(s37DebtImpact.body.balance === 450 && s37DebtImpact.body.canRetire === false, "delete-impact says a debt with $450 owed cannot be archived yet");
  const s37DebtRefused = await s33("DELETE", `/api/debts/${s37DebtId}`, { mode: "archive" });
  assert(
    s37DebtRefused.status === 409 && s37DebtRefused.body.details?.balance === 450,
    `Archive is refused while the debt still has a balance (got ${s37DebtRefused.status})`
  );
  const s37DebtStill = await Account.findByPk(s37DebtId);
  assert(s37DebtStill && s37DebtStill.isActive !== false && parseFloat(s37DebtStill.initialBalance) === 450, "A refused archive leaves the debt and its balance untouched");
  assert(
    (await Transaction.count({ where: { title: "Payment for Suite 37 Loan", isCleared: false } })) === 1,
    "A refused archive leaves the debt's upcoming payment untouched"
  );
  const s37DebtNetBefore = (await getBalancesSummary()).netWorth;
  const s37Final = await s33("POST", `/api/accounts/${s37DebtId}/final-payment`, {});
  assert(s37Final.status === 201 && s37Final.body.balance === 0, "Final payment brings the debt to $0");
  const s37FinalRow = await Transaction.findByPk(s37Final.body.transactionId);
  assert(
    s37FinalRow && s37FinalRow.type === "TRANSFER" && s37FinalRow.isCleared === true && parseFloat(s37FinalRow.amount) === 450 &&
      s37FinalRow.fromAccountId === s37Checking.id && s37FinalRow.toAccountId === s37DebtId,
    "Final payment is one cleared $450 TRANSFER from Checking to the debt"
  );
  const s37FinalAgain = await s33("POST", `/api/accounts/${s37DebtId}/final-payment`, {});
  assert(s37FinalAgain.status === 409, "A second final payment on a $0 debt is refused");
  const s37DebtDelete = await s33("DELETE", `/api/debts/${s37DebtId}`, { mode: "delete", series: "moveToChecking" });
  assert(s37DebtDelete.status === 204, "Deletes the settled debt permanently");
  assert((await getBalancesSummary()).netWorth === s37DebtNetBefore, "Final payment then delete leaves net worth unchanged");
  assert((await Account.findByPk(s37DebtId)) === null, "The deleted debt is gone");
  const s37DebtRows = await Transaction.findAll({ where: { title: "Payment for Suite 37 Loan" } });
  assert(
    s37DebtRows.length === 1 && s37DebtRows[0].isCleared === true && s37DebtRows[0].toAccountId === null,
    "The paid debt payment stays in history (unlinked) and the upcoming one is removed"
  );

  // 37.6 A card with money owed: final payment then archive keeps net worth; overdue and upcoming are told apart
  const s37Card4 = await s33("POST", "/api/credit-cards", { name: "Suite 37 Mastercard", creditLimit: 2000, currentBalance: 300 });
  const s37Card4Id = s37Card4.body.id;
  await Transaction.bulkCreate([
    { title: "Suite 37 Overdue Hydro", amount: 80, date: getTorontoOffsetDate(-3), type: "EXPENSE", category: "Essentials", isCleared: false, fromAccountId: s37Card4Id },
    { title: "Suite 37 Upcoming Gas", amount: 40, date: s37Soon, type: "EXPENSE", category: "Essentials", isCleared: false, fromAccountId: s37Card4Id },
  ]);
  const s37Card4Impact = await s33("GET", `/api/accounts/${s37Card4Id}/delete-impact`);
  const s37OverdueItem = (s37Card4Impact.body.unpaid?.items || []).find((i) => i.title === "Suite 37 Overdue Hydro");
  const s37UpcomingItem = (s37Card4Impact.body.unpaid?.items || []).find((i) => i.title === "Suite 37 Upcoming Gas");
  assert(
    s37Card4Impact.body.unpaid?.overdueCount === 1 && s37Card4Impact.body.unpaid?.upcomingCount === 1 &&
      s37OverdueItem?.overdue === true && s37UpcomingItem?.overdue === false && s37OverdueItem?.date === getTorontoOffsetDate(-3),
    "delete-impact lists 1 overdue and 1 upcoming bill, with dates"
  );
  const s37Card4Refused = await s33("DELETE", `/api/credit-cards/${s37Card4Id}`, {});
  assert(s37Card4Refused.status === 409, "Archive is refused while the card still has $300 owed");
  const s37Card4NetBefore = (await getBalancesSummary()).netWorth;
  const s37Card4Final = await s33("POST", `/api/accounts/${s37Card4Id}/final-payment`, {});
  assert(s37Card4Final.status === 201 && s37Card4Final.body.balance === 0, "Final payment brings the card to $0");
  const s37Card4Archive = await s33("DELETE", `/api/credit-cards/${s37Card4Id}`, { mode: "archive", series: "end" });
  assert(s37Card4Archive.status === 204, "Archives the settled card");
  assert(
    (await getBalancesSummary()).netWorth === s37Card4NetBefore,
    "Final payment then archive leaves net worth unchanged"
  );

  // 37.7 Adjust to $0 records exactly one Adjustment row and leaves Checking alone
  const s37Card5 = await s33("POST", "/api/credit-cards", { name: "Suite 37 Store Card", creditLimit: 500, currentBalance: 120 });
  const s37Card5Id = s37Card5.body.id;
  const s37BadReason = await s33("POST", `/api/accounts/${s37Card5Id}/adjust-to-zero`, { reason: "lost it" });
  assert(s37BadReason.status === 400, "Adjust to $0 rejects an unknown reason with 400");
  const s37CheckingBeforeAdjust = (await getBalancesSummary()).checking;
  const s37Adjust = await s33("POST", `/api/accounts/${s37Card5Id}/adjust-to-zero`, { reason: "closed_by_bank" });
  assert(s37Adjust.status === 201 && s37Adjust.body.balance === 0, "Adjust to $0 brings the card to $0");
  const s37AdjustRows = await Transaction.findAll({
    where: { [Op.or]: [{ fromAccountId: s37Card5Id }, { toAccountId: s37Card5Id }] },
  });
  assert(
    s37AdjustRows.length === 1 && s37AdjustRows[0].category === "Adjustment" && s37AdjustRows[0].isCleared === true &&
      parseFloat(s37AdjustRows[0].amount) === 120 && s37AdjustRows[0].title.includes("closed by bank"),
    `Adjust to $0 records exactly one $120 Adjustment row with its reason (${s37AdjustRows.length} rows)`
  );
  assert((await getBalancesSummary()).checking === s37CheckingBeforeAdjust, "Adjust to $0 does not touch Checking");
  const s37AdjustAgain = await s33("POST", `/api/accounts/${s37Card5Id}/adjust-to-zero`, { reason: "written_off" });
  assert(s37AdjustAgain.status === 409, "Adjust to $0 on a $0 card is refused");
  const s37Card5Archive = await s33("DELETE", `/api/credit-cards/${s37Card5Id}`, {});
  assert(s37Card5Archive.status === 204, "Archives the card once it is adjusted to $0");

  // Goal money already spent, and an overpaid (negative) card, both adjust to exactly $0
  const s37Goal3 = await s33("POST", "/api/savings-goals", { name: "Suite 37 Spent Goal", target_amount: 500, current_amount: 75 });
  const s37Goal3Id = s37Goal3.body.id;
  const s37GoalAdjust = await s33("POST", `/api/accounts/${s37Goal3Id}/adjust-to-zero`, { reason: "spent" });
  assert(s37GoalAdjust.status === 201 && s37GoalAdjust.body.balance === 0, "Adjust to $0 empties a goal whose money was spent");
  const s37Card6 = await s33("POST", "/api/credit-cards", { name: "Suite 37 Overpaid Card", creditLimit: 500, currentBalance: -20 });
  const s37NegAdjust = await s33("POST", `/api/accounts/${s37Card6.body.id}/adjust-to-zero`, { reason: "written_off" });
  assert(s37NegAdjust.status === 201 && s37NegAdjust.body.balance === 0, "Adjust to $0 also clears an overpaid card's credit");
  const s37CheckingImpact = await s33("POST", `/api/accounts/${s37Checking.id}/final-payment`, {});
  assert(s37CheckingImpact.status === 404, "Final payment refuses Primary Checking (404)");

  // 37.8 Ledger edits and deletes cannot change an archived account's balance (it left net worth at $0)
  const s37ArchivedMove = await Transaction.findOne({ where: { title: "Moved from Suite 37 Car" } });
  const s37ArchivedNetBefore = (await getBalancesSummary()).netWorth;
  const s37ArchivedGoalBalance = async () => parseFloat((await Account.findByPk(s37Goal2Id)).initialBalance);
  const s37DelArchived = await s33("DELETE", `/api/expenses/${s37ArchivedMove.id}`);
  assert(
    s37DelArchived.status === 409 && /archived/i.test(s37DelArchived.body?.error || ""),
    `Deleting "Moved from" an archived goal is refused with 409 (got ${s37DelArchived.status})`
  );
  assert(Boolean(await Transaction.findByPk(s37ArchivedMove.id)), "The refused delete keeps the row");
  const s37BulkArchived = await s33("POST", "/api/expenses/bulk-delete", { ids: [s37ArchivedMove.id] });
  assert(s37BulkArchived.status === 409, `Bulk delete of a row on an archived goal is refused with 409 (got ${s37BulkArchived.status})`);
  const s37EditArchived = await s33("PUT", `/api/expenses/${s37ArchivedMove.id}`, { amount: 50 });
  assert(s37EditArchived.status === 409, `Changing the amount of a row on an archived goal is refused with 409 (got ${s37EditArchived.status})`);
  assert(
    parseFloat((await Transaction.findByPk(s37ArchivedMove.id)).amount) === 120,
    "The refused edit keeps the row's amount"
  );
  const s37RenameArchived = await s33("PUT", `/api/expenses/${s37ArchivedMove.id}`, { name: "Moved from Suite 37 Car (old car)", category: "Other" });
  assert(s37RenameArchived.status === 200, `Renaming a row on an archived goal is still allowed (got ${s37RenameArchived.status})`);
  const s37AdjustRow = await Transaction.findOne({ where: { title: { [Op.like]: "Balance adjustment: Suite 37 Store Card%" } } });
  const s37DelAdjust = await s33("DELETE", `/api/expenses/${s37AdjustRow.id}`);
  assert(s37DelAdjust.status === 409, `Deleting the Adjustment row of an archived card is refused with 409 (got ${s37DelAdjust.status})`);
  assert((await s37ArchivedGoalBalance()) === 0, "The archived goal stays at $0");
  assert(parseFloat((await Account.findByPk(s37Card5Id)).initialBalance) === 0, "The archived card stays at $0");
  assert((await getBalancesSummary()).netWorth === s37ArchivedNetBefore, "Refused Ledger changes leave net worth unchanged");

  await Transaction.destroy({
    where: {
      [Op.or]: [
        { title: { [Op.like]: "Suite 37 %" } },
        { title: { [Op.like]: "Payment for Suite 37 %" } },
        { title: { [Op.like]: "Contribution to Suite 37 %" } },
        { title: { [Op.like]: "Moved from Suite 37 %" } },
        { title: { [Op.like]: "Final payment for Suite 37 %" } },
        { title: { [Op.like]: "Balance adjustment: Suite 37 %" } },
      ],
    },
  });
  await Account.destroy({ where: { name: { [Op.like]: "Suite 37 %" } } });

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
