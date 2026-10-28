const crypto = require("crypto");
const { Type } = require("@google/genai");
const { Op } = require("sequelize");
const { Account, Transaction, Budget, Setting, NetWorthSnapshot } = require("../models");
const { getClearedMonthTotals, monthRange, isMonthStr } = require("./trendsService");
const { getSinkingFunds } = require("./sinkingFundService");
const { getBalancesSummary } = require("./netWorthService");

// Month close review (F6): one month's numbers, each computed here. Gemini only writes up to three
// short lines about them (generateCommentary), and a line quoting a $ or % figure that isn't in these
// numbers is dropped.

const torontoDateOf = (when) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(when));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MOVERS_LIMIT = 3;
const COMMENTARY_LINES = 3;
const COMMENTARY_LINE_MAX = 160;
const COMMENTARY_KEY_PREFIX = "month_close_commentary:";

/** The month before "YYYY-MM" */
const previousMonthOf = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** "2026-10" as "October 2026" */
const monthLabel = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

// A category's budget for the month, as GET /api/budgets works it out: the limit, plus last month's
// unspent part (or minus its overspend) when the budget rolls over, never below 0
const budgetForMonth = (budget, previousSpent) => {
  const limit = parseFloat(budget.monthlyLimit) || 0;
  if (!budget.rollover) return round2(limit);
  return round2(Math.max(0, limit + (limit - (previousSpent || 0))));
};

/** Category rows: spent vs budget, with last month's total and the change. Biggest spend first. */
const buildCategories = (current, previous, budgets) => {
  const budgetByCategory = new Map(budgets.map((b) => [b.category, b]));
  const names = new Set([...Object.keys(current), ...Object.keys(previous), ...budgetByCategory.keys()]);
  return [...names]
    .map((category) => {
      const spent = round2(current[category] || 0);
      const prev = round2(previous[category] || 0);
      const budgetRow = budgetByCategory.get(category);
      const budget = budgetRow ? budgetForMonth(budgetRow, previous[category]) : null;
      return {
        category,
        spent,
        budget,
        remaining: budget === null ? null : round2(budget - spent),
        overBudget: budget !== null && spent > budget + 0.004,
        previous: prev,
        change: round2(spent - prev),
      };
    })
    .filter((c) => c.spent !== 0 || c.previous !== 0 || c.budget !== null)
    .sort((a, b) => b.spent - a.spent || a.category.localeCompare(b.category));
};

/** The biggest increases and decreases vs last month (at most three of each) */
const buildMovers = (categories) => {
  const moved = categories.filter((c) => Math.abs(c.change) >= 0.01);
  const pick = (list) =>
    list.slice(0, MOVERS_LIMIT).map(({ category, spent, previous, change }) => ({
      category,
      spent,
      previous,
      change,
      percent: previous > 0 ? Math.round((change / previous) * 1000) / 10 : null,
    }));
  return {
    increases: pick(moved.filter((c) => c.change > 0).sort((a, b) => b.change - a.change)),
    decreases: pick(moved.filter((c) => c.change < 0).sort((a, b) => a.change - b.change)),
  };
};

/**
 * Each active goal: saved at the end of the month (today's balance less what moved in or out after it),
 * what went in during the month, and its target (a sinking fund without one follows its bill).
 */
const buildGoals = async (start, end, todayStr) => {
  let goals = await Account.findAll({
    where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false } },
    order: [["createdAt", "ASC"]],
  });
  // A goal opened after the month didn't exist then
  goals = goals.filter((g) => !g.createdAt || torontoDateOf(g.createdAt) <= end);
  if (goals.length === 0) return [];
  const ids = goals.map((g) => g.id);
  const [flows, funds] = await Promise.all([
    Transaction.findAll({
      attributes: ["amount", "date", "fromAccountId", "toAccountId"],
      where: {
        isCleared: true,
        balanceApplied: true,
        date: { [Op.gte]: start },
        [Op.or]: [{ toAccountId: { [Op.in]: ids } }, { fromAccountId: { [Op.in]: ids } }],
      },
      raw: true,
    }),
    getSinkingFunds(todayStr, null, goals),
  ]);
  return goals.map((g) => {
    let inMonth = 0;
    let after = 0;
    for (const f of flows) {
      const signed =
        (f.toAccountId === g.id ? parseFloat(f.amount) || 0 : 0) - (f.fromAccountId === g.id ? parseFloat(f.amount) || 0 : 0);
      if (!signed) continue;
      if (f.date > end) after += signed;
      else inMonth += signed;
    }
    const saved = round2((parseFloat(g.initialBalance) || 0) - after);
    const ownTarget = parseFloat(g.targetAmount) || 0;
    const target = round2(ownTarget > 0 ? ownTarget : funds.get(g.id)?.target || 0);
    return {
      id: g.id,
      name: g.name,
      saved,
      target: target > 0 ? target : null,
      percent: target > 0 ? Math.min(100, Math.round((saved / target) * 1000) / 10) : null,
      contributed: round2(inMonth),
    };
  });
};

/**
 * Net worth at the start and end of the month. Start: the last nightly snapshot before the month (or
 * the first one in it). End: today's live figure for the current month, else the last snapshot in the
 * month. null when there is no snapshot to compare with.
 */
const buildNetWorth = async (start, end, todayStr) => {
  const before = await NetWorthSnapshot.findOne({ where: { date: { [Op.lt]: start } }, order: [["date", "DESC"]] });
  const startSnap =
    before || (await NetWorthSnapshot.findOne({ where: { date: { [Op.between]: [start, end] } }, order: [["date", "ASC"]] }));
  if (!startSnap) return null;
  let endValue;
  let endDate;
  if (todayStr >= start && todayStr <= end) {
    endValue = (await getBalancesSummary(null, todayStr)).netWorth;
    endDate = todayStr;
  } else {
    const endSnap = await NetWorthSnapshot.findOne({
      where: { date: { [Op.between]: [start, end] } },
      order: [["date", "DESC"]],
    });
    if (!endSnap) return null;
    endValue = parseFloat(endSnap.netWorth) || 0;
    endDate = endSnap.date;
  }
  const startValue = round2(startSnap.netWorth);
  if (endDate === startSnap.date) return null;
  return {
    start: startValue,
    end: round2(endValue),
    change: round2(endValue - startValue),
    startDate: startSnap.date,
    endDate,
  };
};

// The price a series row is compared at: the pre-tax amount for a tax-exclusive bill (as subscriptionService)
const comparableAmount = (t) =>
  t.isTaxExclusive && t.baseAmount !== null && t.baseAmount !== undefined ? parseFloat(t.baseAmount) : parseFloat(t.amount);

/**
 * Recurring bills whose price went up in the month: a paid row dated in the month that cost more than
 * the series' paid row before it. Each series is listed once, with its last rise in the month, so a
 * later change doesn't hide it from a past month's close.
 */
const buildPriceRises = async (start, end) => {
  const rows = await Transaction.findAll({
    attributes: ["title", "amount", "baseAmount", "isTaxExclusive", "date", "recurrence", "recurringGroupId"],
    where: { type: "EXPENSE", isCleared: true, recurringGroupId: { [Op.ne]: null }, date: { [Op.lte]: end } },
    order: [
      ["date", "ASC"],
      ["createdAt", "ASC"],
    ],
  });
  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.recurringGroupId)) bySeries.set(r.recurringGroupId, []);
    bySeries.get(r.recurringGroupId).push(r);
  }
  const rises = [];
  for (const series of bySeries.values()) {
    let rise = null;
    for (let i = 1; i < series.length; i++) {
      const row = series[i];
      if (row.date < start) continue;
      const from = comparableAmount(series[i - 1]);
      const to = comparableAmount(row);
      if (to - from > 0.005) {
        rise = {
          name: row.title,
          cadence: row.recurrence,
          from: round2(from),
          to: round2(to),
          difference: round2(to - from),
          percent: from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : 0,
          date: row.date,
        };
      }
    }
    if (rise) rises.push(rise);
  }
  return rises.sort((a, b) => b.difference - a.difference);
};

/**
 * The month close for "YYYY-MM": spending vs budget by category (the same totals as /spending-summary),
 * the biggest moves vs last month, subscriptions whose price rose in the month, goal progress and the
 * change in net worth. todayStr is Toronto today.
 */
const buildMonthClose = async (month, todayStr) => {
  if (!isMonthStr(month)) throw new Error(`Invalid month: ${month}`);
  const previousMonth = previousMonthOf(month);
  const [start, end] = monthRange(month);
  const [prevStart] = monthRange(previousMonth);

  const [totals, budgets, goals, netWorth] = await Promise.all([
    getClearedMonthTotals(prevStart, end),
    Budget.findAll({ order: [["category", "ASC"]] }),
    buildGoals(start, end, todayStr),
    buildNetWorth(start, end, todayStr),
  ]);
  const current = totals[month] || { income: 0, spending: 0, byCategory: {} };
  const previous = totals[previousMonth] || { income: 0, spending: 0, byCategory: {} };

  const categories = buildCategories(current.byCategory, previous.byCategory, budgets);
  const budgeted = categories.filter((c) => c.budget !== null);
  const { increases, decreases } = buildMovers(categories);

  const priceRises = await buildPriceRises(start, end);

  return {
    month,
    label: monthLabel(month),
    previousMonth,
    // The month is over (it ended before today); the current month is a close so far
    isComplete: end < todayStr,
    totals: {
      spending: round2(current.spending),
      income: round2(current.income),
      net: round2(current.income - current.spending),
      previousSpending: round2(previous.spending),
      spendingChange: round2(current.spending - previous.spending),
      budgeted: round2(budgeted.reduce((s, c) => s + c.budget, 0)),
      spentInBudgeted: round2(budgeted.reduce((s, c) => s + c.spent, 0)),
      overBudgetCount: budgeted.filter((c) => c.overBudget).length,
    },
    categories,
    increases,
    decreases,
    priceRises,
    goals,
    netWorth,
  };
};

// --- Commentary (Gemini writes the words; the numbers above are the server's) ---

const money = (n) =>
  `$${Math.abs(round2(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The facts the model sees: only numbers from the month close */
const commentaryFacts = (close) => ({
  month: close.label,
  year: Number(close.month.slice(0, 4)),
  monthIsOver: close.isComplete,
  spending: close.totals.spending,
  income: close.totals.income,
  spendingLastMonth: close.totals.previousSpending,
  spendingChange: close.totals.spendingChange,
  budgeted: close.totals.budgeted,
  spentInBudgetedCategories: close.totals.spentInBudgeted,
  overBudget: close.categories.filter((c) => c.overBudget).map((c) => ({ category: c.category, spent: c.spent, budget: c.budget })),
  biggestIncreases: close.increases.map(({ category, change, percent }) => ({ category, change, percent })),
  biggestDecreases: close.decreases.map(({ category, change, percent }) => ({ category, change, percent })),
  priceRises: close.priceRises.map(({ name, from, to, percent }) => ({ name, from, to, percent })),
  goals: close.goals.map(({ name, saved, target, percent, contributed }) => ({ name, saved, target, percent, contributed })),
  netWorthChange: close.netWorth ? close.netWorth.change : null,
  // Counts the note may mention ("3 budgets", "2 price rises")
  overBudgetCount: close.totals.overBudgetCount,
  priceRiseCount: close.priceRises.length,
  goalCount: close.goals.length,
});

const buildCommentaryPrompt = (facts) => `You write the month-close note in FinTrack, Maverick's personal finance app.
Here are this month's numbers, worked out by the app (JSON):
${JSON.stringify(facts)}

Write at most ${COMMENTARY_LINES} short lines (each under 20 words) about what stands out: a category that rose or fell, a budget that was missed or kept, a price rise, goal progress or the net worth change.
Rules:
- Use only the numbers above, exactly as given (dollars like $123.45, percents like 12.5%). Write every number in digits. Never calculate a difference, a remainder, a fraction ("half", "two thirds") or any other new number, and never round differently or estimate.
- No advice lists, no greetings, no markdown, no emoji.
- If the month is not over yet (monthIsOver false), say "so far" where it matters.`;

// Every number in the facts, and every name (a category, goal or bill may have digits in it)
const factsVocabulary = (facts) => {
  const numbers = [];
  const names = [];
  const walk = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) numbers.push(Math.abs(v));
    else if (typeof v === "string" && /\d/.test(v)) names.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  // Longest first, so "Trip 2026 fund" is removed before "Trip 2026"
  return { numbers, names: names.sort((a, b) => b.length - a.length) };
};

const quotesKnownNumber = (n, allowed) =>
  allowed.some((a) => Math.abs(a - n) < 0.005 || Math.round(a) === n);

// Each number written in a line ("$1,234.50", "41%", "250 dollars", "1.2k"), as a value
const numbersIn = (text) =>
  [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(k\b)?/gi)].map((m) => {
    const n = parseFloat(m[1].replace(/,/g, ""));
    return m[2] ? n * 1000 : n;
  });

// Numbers written as words count as numbers too ("two budgets" is fine when 2 is a fact). "One" is
// left alone because it is mostly not a count. Fractions and multiples ("half", "twice") are always
// a calculation, and so are "hundred"/"thousand" amounts, so they drop the line.
const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const CALCULATED_WORDS =
  /\b(?:half|halves|halved|thirds?|quarters?|double[ds]?|doubling|twice|triple[ds]?|tripling|quadruple[ds]?|hundreds?|thousands?|millions?)\b/i;

const wordNumbersIn = (text) =>
  [...text.toLowerCase().matchAll(/\b[a-z]+\b/g)].map((m) => NUMBER_WORDS[m[0]]).filter((n) => n !== undefined);

/**
 * The model's lines, cleaned: at most three, bullets and markdown stripped, each cut to a sensible
 * length, and any line with a number that isn't one of the facts' numbers dropped ("$600 to go",
 * "250 dollars", "41 percent" when the facts don't say so). Digits inside a name from the facts
 * (a goal called "Trip 2026") don't count.
 */
const sanitizeCommentary = (lines, facts) => {
  const { numbers, names } = factsVocabulary(facts);
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (out.length >= COMMENTARY_LINES) break;
    let line = String(raw ?? "")
      .replace(/[*_`#>]/g, "")
      .replace(/^\s*(?:[-•]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (line.length > COMMENTARY_LINE_MAX) line = `${line.slice(0, COMMENTARY_LINE_MAX - 1).replace(/\s+\S*$/, "")}…`;
    let figuresText = line;
    for (const name of names) figuresText = figuresText.split(name).join(" ");
    if (numbersIn(figuresText).some((n) => !quotesKnownNumber(n, numbers))) continue;
    if (CALCULATED_WORDS.test(figuresText)) continue;
    if (wordNumbersIn(figuresText).some((n) => !quotesKnownNumber(n, numbers))) continue;
    out.push(line);
  }
  return out;
};

const factsHash = (facts) => crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);

/** A key for these exact numbers: it changes whenever the commentary would (the client keys its query on it) */
const commentaryKeyOf = (close) => factsHash(commentaryFacts(close));

/** Commentary saved for these exact numbers, or null */
const getCachedCommentary = async (close) => {
  const record = await Setting.findByPk(`${COMMENTARY_KEY_PREFIX}${close.month}`);
  if (!record) return null;
  try {
    const saved = JSON.parse(record.value);
    return saved.hash === factsHash(commentaryFacts(close)) && Array.isArray(saved.lines) && saved.lines.length > 0
      ? saved.lines
      : null;
  } catch {
    return null;
  }
};

/**
 * Up to three lines of commentary for a month close, from Gemini. Cached per month for the same
 * numbers, so opening the tab again costs no AI call. Counts against the daily AI cap.
 * Returns { lines, cached } or { lines: [], unavailable: reason } (no API key, cap reached, an error).
 * AI helpers are passed in by the caller (routes/gemini.js owns the client).
 */
const generateCommentary = async (close, { ai, generate, reserveCall, releaseUnanswered, model, todayStr, endpoint = "month-close" }) => {
  const cached = await getCachedCommentary(close);
  if (cached) return { lines: cached, cached: true };
  if (!ai) return { lines: [], unavailable: "no-key" };

  const facts = commentaryFacts(close);
  const reservation = await reserveCall(todayStr);
  if (!reservation.allowed) return { lines: [], unavailable: "cap", message: reservation.message, cap: reservation.cap };
  const usage = { todayStr, endpoint, reserved: true };
  try {
    const response = await generate(
      ai,
      {
        model,
        contents: buildCommentaryPrompt(facts),
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: { lines: { type: Type.ARRAY, items: { type: Type.STRING } } },
            required: ["lines"],
          },
          abortSignal: AbortSignal.timeout(15000),
        },
      },
      usage
    );
    let parsed = {};
    try {
      parsed = JSON.parse(response.text || "{}");
    } catch {
      parsed = { lines: String(response.text || "").split("\n") };
    }
    const lines = sanitizeCommentary(parsed.lines, facts);
    // Nothing usable (every line dropped) isn't kept, so the next try can write a note
    if (lines.length > 0) {
      await Setting.upsert({
        key: `${COMMENTARY_KEY_PREFIX}${close.month}`,
        value: JSON.stringify({ hash: factsHash(facts), lines }),
      });
    }
    return { lines, cached: false };
  } catch (err) {
    await releaseUnanswered(usage);
    console.error("Month close commentary error:", err.message);
    return { lines: [], unavailable: "error" };
  }
};

/**
 * The digest's month-close lines (sent on the 1st for the month that just ended). With amounts off
 * (NOTIFY_DETAIL "counts") it gives counts only.
 */
const digestLines = (close, showAmounts) => {
  const t = close.totals;
  const lines = [];
  if (showAmounts) {
    const change = t.previousSpending > 0 ? ` (${t.spendingChange >= 0 ? "+" : "−"}${money(t.spendingChange)} vs last month)` : "";
    lines.push(`  • Spent ${money(t.spending)}${change}, income ${money(t.income)}`);
    if (t.budgeted > 0) {
      lines.push(
        `  • Budgets: ${money(t.spentInBudgeted)} of ${money(t.budgeted)}` +
          (t.overBudgetCount > 0 ? `, ${t.overBudgetCount} over` : ", all within")
      );
    }
    if (close.increases[0]) lines.push(`  • Biggest increase: ${close.increases[0].category} +${money(close.increases[0].change)}`);
    if (close.priceRises.length > 0) {
      lines.push(`  • Price rises: ${close.priceRises.map((p) => `${p.name} ${money(p.from)} → ${money(p.to)}`).join(", ")}`);
    }
    if (close.netWorth) lines.push(`  • Net worth ${close.netWorth.change >= 0 ? "+" : "−"}${money(close.netWorth.change)}`);
  } else {
    if (t.budgeted > 0) lines.push(`  • ${t.overBudgetCount} budget${t.overBudgetCount === 1 ? "" : "s"} over`);
    if (close.priceRises.length > 0) lines.push(`  • ${close.priceRises.length} subscription price rise(s)`);
    lines.push("  • Open Reports → Month close for the details");
  }
  return lines;
};

module.exports = {
  COMMENTARY_KEY_PREFIX,
  previousMonthOf,
  monthLabel,
  buildMonthClose,
  commentaryFacts,
  buildCommentaryPrompt,
  sanitizeCommentary,
  getCachedCommentary,
  commentaryKeyOf,
  generateCommentary,
  digestLines,
};
