const http = require("http");

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

  // 5. Soft-Delete & Data Preservation Tests
  console.log("\n--- Suite 5: Soft-Delete & CASCADE Protection ---");
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
  assert(delCard.status === 204, "Card soft-deleted with HTTP 204");

  const activeCards = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  const activeMatch = (activeCards.body || []).find((c) => c.id === cardId);
  assert(!activeMatch, "Soft-deleted card omitted from active cards query");

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

  // 6. Historical Expense on Credit Card (Issue 1)
  console.log("\n--- Suite 6: Historical Credit Card Expense Behavior ---");
  const cardHistRes = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "POST",
    headers: authHeaders,
  }, { name: "Historical Test Card", creditLimit: 2000, currentBalance: 500 });
  assert(cardHistRes.status === 201 && cardHistRes.body.id, "Creates card with $500 balance");
  const histCardId = cardHistRes.body.id;

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

  const cardAfterPastExp = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  const histCard = (cardAfterPastExp.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCard.currentBalance) === 500, "Past expense does not increase pre-existing card balance");

  await request({
    hostname: "localhost",
    port: 8000,
    path: `/api/expenses/${pastExpId}`,
    method: "DELETE",
    headers: authHeaders,
  });

  const cardAfterDelPast = await request({
    hostname: "localhost",
    port: 8000,
    path: "/api/credit-cards",
    method: "GET",
    headers: authHeaders,
  });
  const histCardAfterDel = (cardAfterDelPast.body || []).find((c) => c.id === histCardId);
  assert(parseFloat(histCardAfterDel.currentBalance) === 500, "Deleting past expense does not decrement card balance");

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
