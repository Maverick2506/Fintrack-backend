// Unit tests for the bank CSV helpers (utils/csvImport.js) and rule ordering (services/ruleService.js)
process.env.NODE_ENV = "test";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  CsvError,
  parseCsv,
  parseDate,
  parseAmount,
  suggestMapping,
  applyMapping,
  importClientRef,
  withOccurrences,
  titlesSimilar,
} = require("../utils/csvImport");
const { applyRules } = require("../services/ruleService");

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  [PASS] ${name}`);
};
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

console.log("==================================================");
console.log("   FINTRACK CSV IMPORT UNIT TESTS                 ");
console.log("==================================================");

test("parseCsv reads quotes, doubled quotes, commas and newlines in quotes, CRLF and a BOM", () => {
  const rows = parseCsv('﻿a,"b, c","say ""hi"""\r\n\r\n1,"two\nlines",3\r\n');
  assert.deepStrictEqual(rows, [["a", "b, c", 'say "hi"'], ["1", "two\nlines", "3"]]);
});

test("parseCsv refuses an unclosed quote and a binary file", () => {
  assert.throws(() => parseCsv('a,"b\n1,2'), CsvError);
  assert.throws(() => parseCsv("PK\u0003\u0004\u0000\u0000"), CsvError);
});

test("parseDate reads each format and refuses impossible days", () => {
  assert.strictEqual(parseDate("9/1/2026", "MM/DD/YYYY"), "2026-09-01");
  assert.strictEqual(parseDate("01/09/2026", "DD/MM/YYYY"), "2026-09-01");
  assert.strictEqual(parseDate("2026-09-01", "YYYY-MM-DD"), "2026-09-01");
  assert.strictEqual(parseDate("01-Sep-2026", "DD-MMM-YYYY"), "2026-09-01");
  assert.strictEqual(parseDate("Sep 1, 2026", "MMM DD, YYYY"), "2026-09-01");
  assert.strictEqual(parseDate("02/30/2026", "MM/DD/YYYY"), null);
  assert.strictEqual(parseDate("13/01/2026", "MM/DD/YYYY"), null);
});

test("parseAmount reads $, thousands, minus, brackets and trailing minus", () => {
  assert.strictEqual(parseAmount("$1,234.56"), 1234.56);
  assert.strictEqual(parseAmount("-4.50"), -4.5);
  assert.strictEqual(parseAmount("(12.30)"), -12.3);
  assert.strictEqual(parseAmount("12.30-"), -12.3);
  assert.strictEqual(parseAmount("CAD 7"), 7);
  assert.strictEqual(parseAmount(""), null);
  assert.strictEqual(parseAmount("abc"), null);
});

test("RBC chequing export: header row, Description 1 + 2, signed CAD$ column", () => {
  const rows = parseCsv(fixture("rbc-chequing.csv"));
  const m = suggestMapping(rows);
  assert.deepStrictEqual(
    { hasHeader: m.hasHeader, date: m.date, description: m.description, amount: m.amount, dateFormat: m.dateFormat },
    { hasHeader: true, date: 2, description: [4, 5], amount: 6, dateFormat: "MM/DD/YYYY" }
  );
  const { rows: mapped, invalid } = applyMapping(rows, m);
  assert.strictEqual(mapped.length, 8);
  assert.strictEqual(invalid.length, 0);
  assert.deepStrictEqual(mapped[0], { line: 2, date: "2026-09-01", description: "PAYROLL DEPOSIT EXAMPLE CORP", amount: 2100, direction: "in" });
  assert.strictEqual(mapped[7].description, "PHARMACY PLUS, #0007");
  assert.strictEqual(mapped[7].direction, "out");
});

test("TD Visa export: no header, debit and credit columns, a balance column ignored", () => {
  const rows = parseCsv(fixture("td-visa.csv"));
  const m = suggestMapping(rows);
  assert.deepStrictEqual(
    { hasHeader: m.hasHeader, date: m.date, description: m.description, debit: m.debit, credit: m.credit, dateFormat: m.dateFormat },
    { hasHeader: false, date: 0, description: [1], debit: 2, credit: 3, dateFormat: "MM/DD/YYYY" }
  );
  const { rows: mapped } = applyMapping(rows, m);
  assert.deepStrictEqual(mapped.map((r) => [r.amount, r.direction]), [[32.15, "out"], [59.99, "out"], [200, "in"], [19.99, "in"], [61.2, "out"]]);
});

test("outflow 'positive' flips a card export that shows charges as positive", () => {
  const rows = parseCsv("2026-09-01,COFFEE,4.50\n2026-09-02,REFUND,-2.00\n");
  const { rows: mapped } = applyMapping(rows, { hasHeader: false, date: 0, description: [1], amount: 2, dateFormat: "YYYY-MM-DD", outflow: "positive" });
  assert.deepStrictEqual(mapped.map((r) => r.direction), ["out", "in"]);
});

test("applyMapping skips unreadable lines and refuses a file with none readable or too many rows", () => {
  const rows = parseCsv("2026-09-01,COFFEE,-4.50\nTotal,,-4.50\n");
  const { rows: mapped, invalid } = applyMapping(rows, { hasHeader: false, date: 0, description: [1], amount: 2, dateFormat: "YYYY-MM-DD" });
  assert.strictEqual(mapped.length, 1);
  assert.deepStrictEqual(invalid, [{ line: 2, reason: "date not readable" }]);
  assert.throws(() => applyMapping(rows, { hasHeader: false, date: 0, description: [1], amount: 9, dateFormat: "YYYY-MM-DD" }), CsvError);
  assert.throws(() => applyMapping(parseCsv("x,y,z\n"), { hasHeader: false, date: 0, description: [1], amount: 2, dateFormat: "YYYY-MM-DD" }), CsvError);
  const big = Array.from({ length: 2001 }, () => "2026-09-01,A,-1").join("\n");
  assert.throws(() => applyMapping(parseCsv(big), { hasHeader: false, date: 0, description: [1], amount: 2, dateFormat: "YYYY-MM-DD" }), /limit is 2,000/);
});

test("importClientRef is a stable UUID; a repeat in the same file gets its own", () => {
  const a = importClientRef("acc", "2026-09-02", 4.5, "TIM HORTONS #0001");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.strictEqual(a, importClientRef("acc", "2026-09-02", "4.50", "tim hortons #0001"));
  assert.notStrictEqual(a, importClientRef("acc", "2026-09-02", 4.5, "TIM HORTONS #0001", 2));
  assert.notStrictEqual(a, importClientRef("other", "2026-09-02", 4.5, "TIM HORTONS #0001"));
  const occ = withOccurrences([
    { date: "2026-09-02", amount: 4.5, direction: "out", description: "TIM" },
    { date: "2026-09-02", amount: 4.5, direction: "out", description: "TIM" },
    { date: "2026-09-03", amount: 4.5, direction: "out", description: "TIM" },
  ]);
  assert.deepStrictEqual(occ.map((r) => r.occurrence), [1, 2, 1]);
});

test("titlesSimilar: same merchant yes, generic words alone no", () => {
  assert.ok(titlesSimilar("Netflix", "NETFLIX.COM 866-579-7172"));
  assert.ok(titlesSimilar("Hydro bill", "SAMPLE HYDRO-ELEC BILL PAYMENT"));
  assert.ok(titlesSimilar("Payment for TD Visa", "TD VISA PAYMENT"));
  assert.ok(!titlesSimilar("Rent", "E-TRANSFER SENT J SAMPLE"));
  assert.ok(!titlesSimilar("Bill payment", "ONLINE BILL PAYMENT"));
});

test("applyRules: lowest priority number wins each field; a rule may set only one field", () => {
  const rules = [
    { id: "r1", match: "uber", category: "Transportation", accountId: null, priority: 1 },
    { id: "r2", match: "uber eats", category: "Food & Drink", accountId: "card", priority: 2 },
  ];
  assert.deepStrictEqual(applyRules(rules, "UBER EATS TORONTO"), {
    category: "Transportation", accountId: "card", categoryRuleId: "r1", accountRuleId: "r2",
  });
  assert.strictEqual(applyRules(rules, "Lyft").category, null);
});

console.log(`\n   CSV IMPORT UNIT TESTS: ${passed} passed\n`);
