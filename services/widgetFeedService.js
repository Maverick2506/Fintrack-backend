const crypto = require("crypto");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const { Account, Transaction, Budget, Setting } = require("../models");
const { getForecast } = require("./forecastService");
const { getClearedMonthTotals, monthRange } = require("./trendsService");
const { getCardStatement } = require("./statementService");
const { getSinkingFunds } = require("./sinkingFundService");
const { usesArchivedAccount } = require("./accountArchiveService");

// The home-screen widget feed (GET /api/export/widget.json, read by KWGT on Android).
// Flat keys so a KWGT formula is just $wg("<url>", json, ".safe_to_spend")$. Every amount comes as
// a display string ("$412") plus a *_raw number for bars. No transaction history beyond 3 bills.

const TIMEZONE = "America/Toronto";
const WIDGET_TOKEN_KEY = "widget_feed_token";
const WIDGET_HIDE_AMOUNTS_KEY = "widget_hide_amounts";
const WIDGET_TOKEN_PREFIX = "ft_wdg_";
const FORECAST_DAYS = 60;
const SLOTS = 3;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const newWidgetToken = () => `${WIDGET_TOKEN_PREFIX}${crypto.randomBytes(16).toString("hex")}`;

const getOrCreateWidgetToken = async () => {
  const [record] = await Setting.findOrCreate({
    where: { key: WIDGET_TOKEN_KEY },
    defaults: { value: newWidgetToken() },
  });
  if (!record.value) {
    record.value = newWidgetToken();
    await record.save();
  }
  return record.value;
};

const regenerateWidgetToken = async () => {
  const value = newWidgetToken();
  await Setting.upsert({ key: WIDGET_TOKEN_KEY, value });
  return value;
};

const getWidgetHideAmounts = async () => {
  const record = await Setting.findByPk(WIDGET_HIDE_AMOUNTS_KEY);
  return Boolean(record && record.value === "true");
};

const setWidgetHideAmounts = async (hide) => {
  await Setting.upsert({ key: WIDGET_HIDE_AMOUNTS_KEY, value: hide ? "true" : "false" });
  return Boolean(hide);
};

/** Whole dollars for a small widget: 412.37 -> "$412", -50 -> "-$50", 1234 -> "$1,234" */
const widgetMoney = (n) => {
  const whole = Math.round(Number(n) || 0);
  const text = `$${Math.abs(whole).toLocaleString("en-US")}`;
  return whole < 0 ? `-${text}` : text;
};

/** "2026-11-03" -> "Nov 3" */
const shortDate = (dateStr) => {
  if (!dateStr) return "";
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** Toronto time as "Oct 28, 9:14 am" */
const asOfLabel = (now = new Date()) => {
  const zoned = toZonedTime(now, TIMEZONE);
  return `${format(zoned, "MMM d, h:mm", { timeZone: TIMEZONE })} ${format(zoned, "a", { timeZone: TIMEZONE }).toLowerCase()}`;
};

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// Status words that stand in for amounts when "Hide amounts" is on
const billWord = (flag) => (flag === "overdue" ? "Overdue" : flag === "today" ? "Due today" : "Upcoming");
const spentWord = (spent, budget) => {
  if (!(budget > 0)) return spent > 0 ? "Spending" : "No spending";
  const p = (spent / budget) * 100;
  return p > 100 ? "Over budget" : p >= 90 ? "Near budget" : "Under budget";
};
const cardWord = (balance, limit) => {
  if (balance <= 0) return "Paid off";
  if (!(limit > 0)) return "Owing";
  const p = (balance / limit) * 100;
  return p > 100 ? "Over limit" : p >= 90 ? "Near limit" : "Owing";
};
const goalWord = (saved, target) => {
  if (target > 0 && saved >= target) return "Reached";
  return saved > 0 ? "Saving" : "Not started";
};

/**
 * The widget's flat JSON from plain facts (no database), so it can be unit tested.
 * facts: { forecast, bills: [{title, date, amount}], month: {spent, budget, topCategory},
 *          cards: [{name, balance, limit, due}], goals: [{name, saved, target}], todayStr, asOf }
 */
const buildWidgetPayload = (facts, { hideAmounts = false } = {}) => {
  const f = facts.forecast;
  const lastDay = f.days && f.days.length ? f.days[f.days.length - 1].date : f.today;
  const belowBuffer = Boolean(f.lowestPoint && f.lowestPoint.balance < f.buffer);
  const status = f.incomeSource === "none" ? "No income" : belowBuffer || f.safeToSpend <= 0 ? "Low" : "On track";
  // In hide mode the strings become words and the raw dollar numbers are left out (percentages stay)
  const amount = (n, word) => (hideAmounts ? word : widgetMoney(n));
  const raw = (n) => (hideAmounts ? null : round2(n));

  const out = {
    as_of: facts.asOf,
    hide_amounts: hideAmounts,
    status,
    safe_to_spend: amount(f.safeToSpend, status),
    safe_to_spend_raw: raw(f.safeToSpend),
    safe_until: shortDate(f.nextPayday || lastDay),
    next_payday: f.nextPayday ? shortDate(f.nextPayday) : "",
    below_buffer: belowBuffer,
  };

  for (let i = 0; i < SLOTS; i++) {
    const b = facts.bills[i];
    const n = i + 1;
    const flag = !b ? "" : b.date < facts.todayStr ? "overdue" : b.date === facts.todayStr ? "today" : "";
    out[`bill${n}_title`] = b ? b.title : "";
    out[`bill${n}_date`] = b ? shortDate(b.date) : "";
    out[`bill${n}_amount`] = b ? amount(b.amount, billWord(flag)) : "";
    out[`bill${n}_amount_raw`] = b ? raw(b.amount) : hideAmounts ? null : 0;
    out[`bill${n}_flag`] = flag;
  }

  const m = facts.month;
  out.month_spent = amount(m.spent, spentWord(m.spent, m.budget));
  out.month_spent_raw = raw(m.spent);
  out.month_budget = m.budget > 0 ? amount(m.budget, "Budget set") : hideAmounts ? "No budget" : "";
  out.month_budget_raw = raw(m.budget);
  out.month_pct = pct(m.spent, m.budget);
  out.top_category = m.topCategory || "";

  for (let i = 0; i < SLOTS; i++) {
    const c = facts.cards[i];
    const n = i + 1;
    out[`card${n}_name`] = c ? c.name : "";
    out[`card${n}_balance`] = c ? amount(c.balance, cardWord(c.balance, c.limit)) : "";
    out[`card${n}_balance_raw`] = c ? raw(c.balance) : hideAmounts ? null : 0;
    out[`card${n}_pct`] = c ? pct(Math.max(0, c.balance), c.limit) : 0;
    out[`card${n}_due`] = c ? shortDate(c.due) : "";
  }

  for (let i = 0; i < SLOTS; i++) {
    const g = facts.goals[i];
    const n = i + 1;
    out[`goal${n}_name`] = g ? g.name : "";
    out[`goal${n}_saved`] = g ? amount(g.saved, goalWord(g.saved, g.target)) : "";
    out[`goal${n}_saved_raw`] = g ? raw(g.saved) : hideAmounts ? null : 0;
    out[`goal${n}_target`] = g && g.target > 0 ? amount(g.target, "Target set") : "";
    out[`goal${n}_target_raw`] = g ? raw(g.target) : hideAmounts ? null : 0;
    out[`goal${n}_pct`] = g ? Math.min(100, pct(Math.max(0, g.saved), g.target)) : 0;
  }
  return out;
};

// A card's due date as the Credit Cards page shows it: the statement's due date, or the next one
// once a paid statement's date has passed; the card's own due date when it has no statement day
const cardDueDate = (card, statement, todayStr) => {
  if (!statement) return card.dueDate || null;
  const pastDue = Boolean(statement.dueDate && statement.dueDate < todayStr);
  return pastDue && statement.statementBalance <= 0 ? statement.nextDueDate || null : statement.dueDate || null;
};

// A category's budget this month, like GET /api/budgets: rollover adds last month's unspent part
const budgetAvailable = (budget, previousSpent) => {
  const limit = parseFloat(budget.monthlyLimit) || 0;
  if (!budget.rollover) return limit;
  return Math.max(0, limit + (limit - (previousSpent || 0)));
};

/** Loads the facts from the same services the app uses and builds the widget JSON */
const getWidgetFeed = async ({ now = new Date() } = {}) => {
  const todayStr = format(toZonedTime(now, TIMEZONE), "yyyy-MM-dd", { timeZone: TIMEZONE });
  const ym = todayStr.slice(0, 7);
  const [y, mo] = ym.split("-").map(Number);
  const prevYm = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  const [, monthEnd] = monthRange(ym);
  const [prevStart] = monthRange(prevYm);

  const [forecast, billRows, totals, budgets, cards, goals, hideAmounts] = await Promise.all([
    // Same call as the Dashboard's Safe to Spend card (GET /api/forecast)
    getForecast(FORECAST_DAYS),
    // Unpaid bills, overdue first. Card and debt payments are TRANSFERs but still due, like the Dashboard.
    Transaction.findAll({
      where: { type: { [Op.in]: ["EXPENSE", "TRANSFER"] }, isCleared: false },
      order: [
        ["date", "ASC"],
        ["createdAt", "ASC"],
      ],
      include: [
        { model: Account, as: "fromAccount", attributes: ["isActive"] },
        { model: Account, as: "toAccount", attributes: ["isActive"] },
      ],
      limit: 20,
    }),
    // Same totals as /spending-summary and the month close
    getClearedMonthTotals(prevStart, monthEnd),
    Budget.findAll(),
    Account.findAll({
      where: { type: "CREDIT_CARD", isActive: { [Op.ne]: false } },
      order: [["createdAt", "ASC"]],
      limit: SLOTS,
    }),
    Account.findAll({
      where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false } },
      order: [["createdAt", "ASC"]],
      limit: SLOTS,
    }),
    getWidgetHideAmounts(),
  ]);

  const bills = billRows
    .filter((b) => !usesArchivedAccount(b))
    .slice(0, SLOTS)
    .map((b) => ({ title: b.title, date: b.date, amount: parseFloat(b.amount) || 0 }));

  const current = totals[ym] || { spending: 0, byCategory: {} };
  const previous = (totals[prevYm] || { byCategory: {} }).byCategory;
  const budget = budgets.reduce((sum, b) => sum + budgetAvailable(b, previous[b.category]), 0);
  const top = Object.entries(current.byCategory)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const cardFacts = await Promise.all(
    cards.map(async (c) => ({
      name: c.name,
      balance: parseFloat(c.initialBalance) || 0,
      limit: parseFloat(c.creditLimit) || 0,
      due: cardDueDate(c, await getCardStatement(c, todayStr), todayStr),
    }))
  );

  // A sinking fund with no target of its own saves for its bill's amount (as on the Dashboard)
  const sinking = await getSinkingFunds(todayStr, null, goals);
  const goalFacts = goals.map((g) => {
    const own = parseFloat(g.targetAmount) || 0;
    return {
      name: g.name,
      saved: parseFloat(g.initialBalance) || 0,
      target: own > 0 ? own : parseFloat(sinking.get(g.id)?.target) || 0,
    };
  });

  return buildWidgetPayload(
    {
      forecast,
      bills,
      month: { spent: round2(current.spending), budget: round2(budget), topCategory: top ? top[0] : "" },
      cards: cardFacts,
      goals: goalFacts,
      todayStr,
      asOf: asOfLabel(now),
    },
    { hideAmounts }
  );
};

module.exports = {
  WIDGET_TOKEN_PREFIX,
  getOrCreateWidgetToken,
  regenerateWidgetToken,
  getWidgetHideAmounts,
  setWidgetHideAmounts,
  buildWidgetPayload,
  getWidgetFeed,
  widgetMoney,
  asOfLabel,
};
