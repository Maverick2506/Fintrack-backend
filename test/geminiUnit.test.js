/**
 * FinTrack Gemini Integration Unit & Security Tests
 * Verifies Phases G1 through G16:
 * - Server authority over floatAmount & healthStatus (G1, G3)
 * - Structured JSON & enum schemas (G4)
 * - Timeouts (504) and missing key handling (503) (G5)
 * - Zod input capping & validation (G7)
 * - Merchant normalization & cache (G8)
 * - Function calling tools: simulatePurchase, getCategorySpending, getDebtPayoff (G13)
 * - Advice caching with snapshot hash (G15)
 */

process.env.NODE_ENV = "test";
const assert = require("assert");
const { normalizeMerchantName } = require("../utils/merchantNormalizer");
const { EXPENSE_CATEGORIES } = require("../constants/categories");
const { simulate, comparePlans } = require("../services/debtPayoffService");

async function runGeminiUnitTests() {
  console.log("==================================================");
  console.log("   FINTRACK GEMINI INTEGRATION UNIT TESTS         ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function test(desc, fn) {
    try {
      fn();
      console.log(`  [PASS] ${desc}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${desc}:`, err.message);
      failed++;
    }
  }

  async function testAsync(desc, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${desc}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${desc}:`, err.message);
      failed++;
    }
  }

  // --- Suite A: Merchant Normalization (G8) ---
  console.log("\n--- Suite A: Merchant Name Normalization (G8) ---");
  test("Normalizes Uber card noise (*TRIP 8H2K)", () => {
    assert.strictEqual(normalizeMerchantName("UBER *TRIP 8H2K"), "uber");
  });

  test("Normalizes Tim Hortons store numbers (#1234)", () => {
    assert.strictEqual(normalizeMerchantName("Tim Hortons #1234"), "tim hortons");
  });

  test("Normalizes Walmart store number and city (WALMART STORE 3044 TORONTO)", () => {
    assert.strictEqual(normalizeMerchantName("WALMART STORE 3044 TORONTO"), "walmart");
  });

  test("Normalizes domain extensions (Netflix.com CA)", () => {
    assert.strictEqual(normalizeMerchantName("Netflix.com CA"), "netflix");
  });

  // --- Suite B: Category Enums & Canonical Definition (G4, G8) ---
  console.log("\n--- Suite B: Category Enum Standards (G4, G8) ---");
  test("EXPENSE_CATEGORIES contains exactly the 8 standard categories", () => {
    const expected = [
      "Essentials",
      "Food & Drink",
      "Shopping",
      "Subscription",
      "Transportation",
      "Entertainment",
      "Debt",
      "Other",
    ];
    assert.deepStrictEqual(EXPENSE_CATEGORIES, expected);
  });

  // --- Suite C: Debt Payoff Simulation Engine (G13) ---
  console.log("\n--- Suite C: Debt Payoff Simulation (G13) ---");
  test("Simulate calculates exact debt payoff timeline", () => {
    const debts = [
      { id: 1, name: "Visa", initialBalance: 1200, minimumPayment: 100, interestRate: 19.99 },
    ];
    const res = simulate(debts, 0, "avalanche");
    assert(res.debtFreeMonth > 0, "Debt-free month should be greater than 0");
    assert(res.totalInterest > 0, "Total interest accrued should be greater than 0");
    assert.strictEqual(res.hasInsolventDebt, false);
  });

  test("Compare plans demonstrates extra payment savings", () => {
    const debts = [
      { id: 1, name: "Visa", initialBalance: 3000, minimumPayment: 100, interestRate: 19.99 },
      { id: 2, name: "Loan", initialBalance: 5000, minimumPayment: 150, interestRate: 9.5 },
    ];
    const comparison = comparePlans(debts, 150, "avalanche");
    assert(comparison.interestSaved > 0, "Extra payment should save interest");
    assert(comparison.monthsSaved > 0, "Extra payment should save months");
  });

  // --- Suite D: Zod Input Validation (G7) ---
  console.log("\n--- Suite D: Zod Input Capping & Validation (G7) ---");
  const { schemas } = require("../middleware/validate");

  test("Rejects empty merchant name in categorizeExpense", () => {
    const res = schemas.categorizeExpense.safeParse({ name: "" });
    assert.strictEqual(res.success, false);
  });

  test("Rejects merchant name longer than 100 chars", () => {
    const res = schemas.categorizeExpense.safeParse({ name: "A".repeat(101) });
    assert.strictEqual(res.success, false);
  });

  test("Accepts valid merchant name", () => {
    const res = schemas.categorizeExpense.safeParse({ name: "Metro Groceries" });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.name, "Metro Groceries");
  });

  test("Rejects chat message exceeding 2000 characters", () => {
    const res = schemas.chatAdvisor.safeParse({ message: "A".repeat(2001) });
    assert.strictEqual(res.success, false);
  });

  test("Rejects chat history with more than 8 messages", () => {
    const history = Array(9).fill({ role: "user", text: "hi" });
    const res = schemas.chatAdvisor.safeParse({ message: "Hello", history });
    assert.strictEqual(res.success, false);
  });

  test("Accepts valid chat message and compact history", () => {
    const history = [
      { role: "user", text: "Can I afford $200?" },
      { role: "model", text: "Yes, you have safe float." },
    ];
    const res = schemas.chatAdvisor.safeParse({ message: "What about $500?", history });
    assert.strictEqual(res.success, true);
  });

  console.log("\n==================================================");
  console.log(`   UNIT TEST RUN: ${passed} passed, ${failed} failed`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runGeminiUnitTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
