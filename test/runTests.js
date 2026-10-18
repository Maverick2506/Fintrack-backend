const http = require("http");
const { getNextOccurrenceDate, getNextDueDate } = require("../routes/recurring");

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
      validCsvRes.raw.includes("ACCOUNTS"),
    "Returns formatted CSV feed containing OVERVIEW and ACCOUNTS sections"
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
