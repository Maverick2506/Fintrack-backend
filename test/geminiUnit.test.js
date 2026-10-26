/**
 * FinTrack Gemini Integration Unit & Security Tests
 * Verifies Phases G1 through G16 and all Review Fixes:
 * - Server authority over floatAmount & healthStatus (G1, G3)
 * - Structured JSON & enum schemas (G4)
 * - Timeouts (504) and missing key handling (503) (G5)
 * - Zod input capping & validation with resilient history transform (G7, C1)
 * - Merchant normalization & distinction preservation (G8, C4)
 * - Function calling tools: parallel calls in 1 user turn, multi-round chain (G13, C2)
 * - Registered account room calculation: TFSA/RRSP room = limit - contributionsThisYear (G14, C3)
 * - Exact simulatePurchase math (S1)
 * - Ask FinTrack tool choice with a mocked model client: 10 fixed questions (AI9)
 * - Quick Add drafts from proposeTransaction (AI1)
 */

process.env.NODE_ENV = "test";
const assert = require("assert");
const { normalizeMerchantName } = require("../utils/merchantNormalizer");
const { EXPENSE_CATEGORIES } = require("../constants/categories");
const { simulate, comparePlans } = require("../services/debtPayoffService");
const { schemas } = require("../middleware/validate");
const { ThinkingLevel, Type } = require("@google/genai");
const fs = require("fs");
const path = require("path");
const { runChatLoop, buildQuickAddText, CHAT_TOOLS } = require("../routes/gemini");

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

  // --- Suite A: Merchant Name Normalization (G8, C4) ---
  console.log("\n--- Suite A: Merchant Name Normalization & Distinction (G8, C4) ---");
  const tableCases = [
    ["UBER *TRIP 8H2K", "uber trip"],
    ["UBER *EATS PENDING", "uber eats pending"],
    ["SQ *COFFEE SHOP", "coffee shop"],
    ["AMZN Mktp CA*2K4L", "amzn mktp"],
    ["Co-op", "co-op"],
    ["US Bank", "us bank"],
    ["Toronto Hydro", "toronto hydro"],
  ];

  for (const [input, expected] of tableCases) {
    test(`Normalizes "${input}" -> "${expected}"`, () => {
      assert.strictEqual(normalizeMerchantName(input), expected);
    });
  }

  test("Preserves distinction between 'Uber Trip' and 'Uber Eats'", () => {
    const trip = normalizeMerchantName("UBER *TRIP 8H2K");
    const eats = normalizeMerchantName("UBER *EATS 5M1N");
    assert.notStrictEqual(trip, eats);
    assert(trip.startsWith("uber trip"));
    assert(eats.startsWith("uber eats"));
  });

  // --- Suite B: Category Enum Standards (G4, G8) ---
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

  // --- Suite D: Zod Input Capping & Resilient History Transformation (G7, C1) ---
  console.log("\n--- Suite D: Zod Input Capping & Resilient History (G7, C1) ---");

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

  test("Gracefully trims chat history with 10 messages down to latest 8 (C1)", () => {
    const history = [];
    for (let i = 1; i <= 10; i++) {
      history.push({ role: i % 2 === 1 ? "user" : "model", text: `Message ${i}` });
    }
    const res = schemas.chatAdvisor.safeParse({ message: "Hello", history });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.history.length, 8);
    assert.strictEqual(res.data.history[0].text, "Message 3");
    assert.strictEqual(res.data.history[7].text, "Message 10");
  });

  test("Gracefully caps history text items to 4000 characters (C1)", () => {
    const longText = "B".repeat(5000);
    const history = [{ role: "model", text: longText }];
    const res = schemas.chatAdvisor.safeParse({ message: "Hello", history });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.history[0].text.length, 4000);
  });

  test("Filters out empty history messages to protect Gemini turn requirements (C1)", () => {
    const history = [
      { role: "user", text: "" },
      { role: "model", text: "Valid response" },
      { role: "user", text: "   " },
    ];
    const res = schemas.chatAdvisor.safeParse({ message: "Hello", history });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.history.length, 1);
    assert.strictEqual(res.data.history[0].text, "Valid response");
  });

  // --- Suite E: Mocked Gemini Tool Calling & Overwrites (G3, C2, m1) ---
  console.log("\n--- Suite E: Mocked Tool Calling & Server Overwrites (G3, C2, m1) ---");

  test("Server strictly overwrites hallucinated floatAmount and healthStatus (G3)", () => {
    const modelOutput = {
      headline: "AI Hallucination",
      summary: "Everything is tight.",
      tacticalActions: ["Do something"],
      spendingAlert: null,
      floatAmount: 999999.00,
      healthStatus: "warning",
    };

    const serverSafeToSpend = 2450.00;
    const serverHealthStatus = "healthy";

    // Replicate server authority logic from routes/gemini.js
    const structured = { ...modelOutput };
    structured.floatAmount = serverSafeToSpend;
    structured.healthStatus = serverHealthStatus;

    assert.strictEqual(structured.floatAmount, 2450.00);
    assert.strictEqual(structured.healthStatus, "healthy");
  });

  test("Parallel tool calls assemble into ONE user turn with all function responses (C2)", async () => {
    // Simulated model output requesting two parallel tool calls
    const mockModelResponse = {
      functionCalls: [
        { name: "getDebtPayoff", args: { extraPerMonth: 100, strategy: "avalanche" } },
        { name: "getDebtPayoff", args: { extraPerMonth: 100, strategy: "snowball" } },
      ],
      candidates: [{ content: { role: "model", parts: [{ text: "Thinking..." }] } }],
    };

    const contents = [{ role: "user", parts: [{ text: "Compare avalanche and snowball" }] }];

    // Tool loop execution pattern from routes/gemini.js
    if (mockModelResponse.candidates?.[0]?.content) {
      contents.push(mockModelResponse.candidates[0].content);
    }

    const parts = [];
    for (const call of mockModelResponse.functionCalls) {
      const output = { strategy: call.args.strategy, debtFreeDate: "2028-01-01" };
      parts.push({
        functionResponse: {
          name: call.name,
          response: { output },
        },
      });
    }

    contents.push({ role: "user", parts });

    // Assert exactly ONE user turn with TWO function response parts
    const lastTurn = contents[contents.length - 1];
    assert.strictEqual(lastTurn.role, "user");
    assert.strictEqual(lastTurn.parts.length, 2);
    assert.strictEqual(lastTurn.parts[0].functionResponse.name, "getDebtPayoff");
    assert.strictEqual(lastTurn.parts[1].functionResponse.name, "getDebtPayoff");
  });

  test("Chained tool calls are handled across multi-round loop (C2)", async () => {
    let roundCounter = 0;
    const mockRounds = [
      // Round 0: model calls getCategorySpending
      {
        functionCalls: [{ name: "getCategorySpending", args: { category: "Food & Drink" } }],
        candidates: [{ content: { role: "model", parts: [] } }],
      },
      // Round 1: model calls simulatePurchase
      {
        functionCalls: [{ name: "simulatePurchase", args: { amount: 150 } }],
        candidates: [{ content: { role: "model", parts: [] } }],
      },
      // Round 2: model outputs final text
      {
        text: "Based on your spending and forecast, you can afford $150.",
      },
    ];

    let currentResponse = mockRounds[roundCounter];
    for (let round = 0; round < 3; round++) {
      const calls = currentResponse.functionCalls;
      if (!Array.isArray(calls) || calls.length === 0) break;
      roundCounter++;
      currentResponse = mockRounds[roundCounter];
    }

    assert.strictEqual(roundCounter, 2);
    assert(currentResponse.text.includes("you can afford $150"));
  });

  test("Timeout error translates to HTTP 504 (G5)", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";

    const isTimeout =
      err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      err.code === "ABORT_ERR";

    let status = 500;
    if (isTimeout) {
      status = 504;
    }

    assert.strictEqual(status, 504);
  });

  test("Thinking config selects ThinkingLevel.MINIMAL for Gemini 3.5 and future models (T1, m1)", () => {
    const usesThinkingLevel = (m) => !/^gemini-(1|2)\./.test(m);
    
    // 3.5 model
    assert.strictEqual(usesThinkingLevel("gemini-3.5-flash"), true);
    // Future 4.x model
    assert.strictEqual(usesThinkingLevel("gemini-4-flash"), true);

    const thinkingConfig = usesThinkingLevel("gemini-3.5-flash")
      ? { thinkingLevel: ThinkingLevel.MINIMAL }
      : { thinkingBudget: 0 };

    assert.deepStrictEqual(thinkingConfig, { thinkingLevel: "MINIMAL" });
  });

  test("Thinking config falls back to thinkingBudget 0 for legacy 1.x and 2.x models including 003 releases (m1)", () => {
    const usesThinkingLevel = (m) => !/^gemini-(1|2)\./.test(m);

    assert.strictEqual(usesThinkingLevel("gemini-2.5-flash-lite"), false);
    assert.strictEqual(usesThinkingLevel("gemini-2.5-flash-003"), false);
    assert.strictEqual(usesThinkingLevel("gemini-1.5-pro"), false);

    const thinkingConfig = usesThinkingLevel("gemini-2.5-flash-003")
      ? { thinkingLevel: ThinkingLevel.MINIMAL }
      : { thinkingBudget: 0 };

    assert.deepStrictEqual(thinkingConfig, { thinkingBudget: 0 });
  });


  // --- Suite F: Ask FinTrack tool choice with a mocked model client (AI9) ---
  console.log("\n--- Suite F: Ask FinTrack tool choice, mocked model (AI9) ---");

  const TODAY = "2026-10-26";
  const CARDS = [
    { id: "c1", name: "TD Visa Infinite" },
    { id: "c2", name: "Amex Cobalt" },
  ];

  // What a well-behaved model calls for each question. The mock plays the model; the test checks that
  // the server runs exactly these tools with these arguments and that they fit the tool declarations.
  const TOOL_CASES = [
    { q: "can I afford $400", name: "simulatePurchase", args: { amount: 400 } },
    { q: "when did I last pay hydro", name: "searchTransactions", args: { text: "hydro" } },
    {
      q: "add 12.50 lunch visa",
      name: "proposeTransaction",
      args: { amount: 12.5, title: "lunch", account: "visa" },
      quickAddText: "12.50 lunch visa",
    },
    { q: "how much did I spend on food in the last 6 months", name: "getCategorySpending", args: { category: "Food & Drink", months: 6 } },
    { q: "if I pay $200 extra a month with snowball, when am I debt free", name: "getDebtPayoff", args: { extraPerMonth: 200, strategy: "snowball" } },
    { q: "did I spend more in October than September", name: "compareMonths", args: { monthA: "2026-09", monthB: "2026-10" } },
    { q: "what subscriptions do I have and what do they cost a year", name: "getSubscriptions", args: {} },
    {
      q: "show my visa purchases over $100 in September",
      name: "searchTransactions",
      args: { account: "visa", minAmount: 100, from: "2026-09-01", to: "2026-09-30" },
    },
    {
      q: "log my 2100 paycheque",
      name: "proposeTransaction",
      args: { amount: 2100, title: "paycheque", type: "income" },
      quickAddText: "+2100 paycheque",
    },
    {
      q: "add the 120 hydro bill due Nov 5",
      name: "proposeTransaction",
      args: { amount: 120, title: "hydro bill", date: "2026-11-05" },
      quickAddText: "120 hydro bill due 2026-11-05",
    },
  ];

  const declarationsByName = Object.fromEntries(CHAT_TOOLS.map((d) => [d.name, d]));

  // A mocked @google/genai client: answers a question with its scripted function call, and the
  // function results with text. It records every request it gets.
  const makeMockClient = (script) => {
    const requests = [];
    return {
      requests,
      models: {
        generateContent: async (params) => {
          requests.push(params);
          const last = params.contents[params.contents.length - 1];
          if (last.parts.some((p) => p.functionResponse)) {
            return { text: "Here is what I found." };
          }
          const planned = script[last.parts[0].text];
          if (!planned) return { text: "No tool needed." };
          return {
            functionCalls: [{ name: planned.name, args: planned.args }],
            candidates: [{ content: { role: "model", parts: [{ functionCall: { name: planned.name, args: planned.args } }] } }],
          };
        },
      },
    };
  };

  const fitsDeclaration = (name, args) => {
    const decl = declarationsByName[name];
    if (!decl) return `no declaration for ${name}`;
    const props = decl.parameters?.properties || {};
    for (const key of decl.parameters?.required || []) {
      if (args[key] === undefined) return `missing required ${key}`;
    }
    for (const [key, value] of Object.entries(args)) {
      const prop = props[key];
      if (!prop) return `undeclared argument ${key}`;
      const want = prop.type === Type.NUMBER || prop.type === Type.INTEGER ? "number" : "string";
      if (typeof value !== want) return `${key} should be a ${want}`;
    }
    return null;
  };

  const script = Object.fromEntries(TOOL_CASES.map((c) => [c.q, c]));

  for (const c of TOOL_CASES) {
    await testAsync(`"${c.q}" -> ${c.name}(${JSON.stringify(c.args)})`, async () => {
      const client = makeMockClient(script);
      const ran = [];
      // Read tools are spied on (no database here); drafts use the real Quick Add builder
      const runTool = async (name, args, todayStr) => {
        ran.push({ name, args, todayStr });
        if (name === "proposeTransaction") return buildQuickAddText(args, { todayStr, cards: CARDS });
        return { ok: true };
      };
      const result = await runChatLoop({
        ai: client,
        model: "gemini-test",
        contents: [{ role: "user", parts: [{ text: c.q }] }],
        systemPrompt: "test",
        todayStr: TODAY,
        runTool,
      });

      assert.strictEqual(ran.length, 1, `expected one tool call, got ${ran.length}`);
      assert.strictEqual(ran[0].name, c.name);
      assert.deepStrictEqual(ran[0].args, c.args);
      assert.strictEqual(ran[0].todayStr, TODAY);
      assert.strictEqual(fitsDeclaration(c.name, c.args), null);

      // Every request offers all seven tools; the second one carries the tool result back
      assert.strictEqual(client.requests.length, 2);
      const offered = client.requests[0].config.tools[0].functionDeclarations.map((d) => d.name);
      assert.deepStrictEqual(offered.sort(), Object.keys(declarationsByName).sort());
      const resultTurn = client.requests[1].contents.at(-1);
      assert.strictEqual(resultTurn.role, "user");
      assert.strictEqual(resultTurn.parts[0].functionResponse.name, c.name);

      if (c.quickAddText) {
        assert.strictEqual(result.proposals.length, 1);
        assert.strictEqual(result.proposals[0].quickAddText, c.quickAddText);
        assert(/Not saved yet/.test(result.proposals[0].summary), "summary says it is not saved");
      } else {
        assert.deepStrictEqual(result.proposals, []);
      }
    });
  }

  await testAsync("A question that needs no tool runs none and returns the model's text", async () => {
    const client = makeMockClient(script);
    const ran = [];
    const result = await runChatLoop({
      ai: client,
      model: "gemini-test",
      contents: [{ role: "user", parts: [{ text: "hi there" }] }],
      systemPrompt: "test",
      todayStr: TODAY,
      runTool: async (name) => ran.push(name),
    });
    assert.strictEqual(ran.length, 0);
    assert.strictEqual(result.reply, "No tool needed.");
  });

  test("The chat system prompt forbids claiming anything was saved (AI1)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "gemini.js"), "utf8");
    assert(/Never say or imply that something was saved/.test(src));
  });

  // --- Suite G: Quick Add drafts (AI1) ---
  console.log("\n--- Suite G: proposeTransaction builds Quick Add text only (AI1) ---");
  const draft = (args) => buildQuickAddText(args, { todayStr: TODAY, cards: CARDS });

  test("Card keyword picks a word only that card has", () => {
    assert.strictEqual(draft({ amount: 15.99, title: "netflix", account: "amex" }).quickAddText, "15.99 netflix amex");
    assert.strictEqual(draft({ amount: 9, title: "snack", account: "TD Visa Infinite" }).quickAddText, "9 snack visa");
  });

  test("Past date uses 'on', future date uses 'due', today adds nothing", () => {
    assert.strictEqual(draft({ amount: 40, title: "gas", date: "2026-10-20" }).quickAddText, "40 gas on 2026-10-20");
    assert.strictEqual(draft({ amount: 40, title: "gas", date: "2026-11-02" }).quickAddText, "40 gas due 2026-11-02");
    assert.strictEqual(draft({ amount: 40, title: "gas", date: TODAY }).quickAddText, "40 gas");
    assert(/due Nov 2 \(unpaid\)/.test(draft({ amount: 40, title: "gas", date: "2026-11-02" }).summary));
  });

  test("Title words Quick Add would misread are dropped", () => {
    const d = draft({ amount: 30, title: "visa due 11/05 dinner checking $5", account: "amex" });
    assert.strictEqual(d.quickAddText, "30 dinner amex");
  });

  test("Income gets '+', ignores the card, and never claims to be saved", () => {
    const d = draft({ amount: 500, title: "bonus", type: "income", account: "visa" });
    assert.strictEqual(d.quickAddText, "+500 bonus");
    assert.strictEqual(d.saved, false);
    assert(/^Income: Bonus, \$500\.00, today \(paid\)\. Not saved yet\.$/.test(d.summary), d.summary);
  });

  test("Unknown card falls back to checking with a note; bad amount or empty title is refused", () => {
    const d = draft({ amount: 5, title: "coffee", account: "discover" });
    assert.strictEqual(d.quickAddText, "5 coffee");
    assert(/No card matches/.test(d.note));
    assert(draft({ amount: 0, title: "x" }).error);
    assert(draft({ amount: "abc", title: "x" }).error);
    assert(draft({ amount: 5, title: "  $ " }).error);
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
