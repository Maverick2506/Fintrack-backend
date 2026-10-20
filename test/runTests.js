const http = require("http");
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
