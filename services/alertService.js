const crypto = require("crypto");
const { Op } = require("sequelize");
const { Account, Transaction, Setting } = require("../models");
const { getSubscriptionsSummary } = require("./subscriptionService");
const { normalizePayeeTitle } = require("../utils/payeeNormalizer");
const {
  getNextOccurrenceDate,
  markSeriesRestart,
  ACTIVE_RECURRENCES,
} = require("../routes/recurring");

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (dateStr, days) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12) + days * DAY_MS).toISOString().slice(0, 10);
};
const dayDiff = (a, b) => {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / DAY_MS);
};
const round2 = (n) => Math.round(n * 100) / 100;
const withinPct = (a, b, pct) => b > 0 && Math.abs(a - b) / b <= pct;

// ---------------------------------------------------------------------------------------------------
// Price changes: a series' newest paid charge differs from the one before by more than 5%
// (the same comparison as the Subscriptions page, subscriptionService priceChange). The nightly job
// records each change once, keyed by series and charge (Setting price_alert:<seriesId> = row id), and
// queues it for the morning digest (Setting price_alerts_pending), which sends it to ntfy once.
// ---------------------------------------------------------------------------------------------------
const PRICE_CHANGE_PCT = 0.05;
// A change older than this when first seen (the first run after deploy) is history, not news
const PRICE_CHANGE_MAX_AGE_DAYS = 35;
const PRICE_ALERTS_PENDING_KEY = "price_alerts_pending";
const PRICE_ALERT_SEEN_PREFIX = "price_alert:";

const readJsonSetting = async (key, fallback, dbTx = null) => {
  const setting = await Setting.findByPk(key, { transaction: dbTx });
  if (!setting) return fallback;
  try {
    return JSON.parse(setting.value);
  } catch {
    return fallback;
  }
};

const recordPriceChanges = async (todayStr, dbTx = null) => {
  const { subscriptions } = await getSubscriptionsSummary(todayStr, dbTx);
  const oldest = addDays(todayStr, -PRICE_CHANGE_MAX_AGE_DAYS);
  const alerts = [];
  for (const sub of subscriptions) {
    const change = sub.priceChange;
    if (!change || !(change.from > 0) || change.date < oldest) continue;
    if (Math.abs(change.to - change.from) / change.from <= PRICE_CHANGE_PCT) continue;
    const key = `${PRICE_ALERT_SEEN_PREFIX}${sub.id}`;
    const seen = await Setting.findByPk(key, { transaction: dbTx });
    if (seen && seen.value === change.rowId) continue;
    await Setting.upsert({ key, value: change.rowId }, { transaction: dbTx });
    alerts.push({
      seriesId: sub.id,
      title: sub.name,
      from: round2(change.from),
      to: round2(change.to),
      date: change.date,
    });
  }
  if (alerts.length > 0) {
    const pending = await readJsonSetting(PRICE_ALERTS_PENDING_KEY, [], dbTx);
    const kept = (Array.isArray(pending) ? pending : []).filter(
      (p) => !alerts.some((a) => a.seriesId === p.seriesId)
    );
    await Setting.upsert(
      { key: PRICE_ALERTS_PENDING_KEY, value: JSON.stringify([...kept, ...alerts]) },
      { transaction: dbTx }
    );
  }
  return alerts;
};

// The digest takes the queued alerts and clears the queue, so each is sent once
const takePendingPriceAlerts = async (dbTx = null) => {
  const pending = await readJsonSetting(PRICE_ALERTS_PENDING_KEY, [], dbTx);
  if (!Array.isArray(pending) || pending.length === 0) return [];
  await Setting.destroy({ where: { key: PRICE_ALERTS_PENDING_KEY }, transaction: dbTx });
  return pending;
};

const formatPriceAlert = (a) => `${a.title} $${a.from.toFixed(2)} → $${a.to.toFixed(2)}`;

// ---------------------------------------------------------------------------------------------------
// Possible subscriptions: one-off expenses (no series) with the same normalized title and an amount
// within 5% of the newest, about a month apart (25-35 days), 3 times in a row, the newest in the last
// 45 days. Titles that already have a running expense series, or that were dismissed, are left out.
// ---------------------------------------------------------------------------------------------------
const SUGGEST_AMOUNT_PCT = 0.05;
const SUGGEST_MIN_GAP = 25;
const SUGGEST_MAX_GAP = 35;
const SUGGEST_COUNT = 3;
const SUGGEST_LOOKBACK_DAYS = 120;
const SUGGEST_MAX_AGE_DAYS = 45;
const SUGGESTIONS_DISMISSED_KEY = "subscription_suggestions_dismissed";

// rows: one title's rows, newest first. Returns the matched rows newest first, or null.
const findMonthlyChain = (rows) => {
  const newest = rows[0];
  const amount = parseFloat(newest.amount);
  const chain = [newest];
  for (const row of rows.slice(1)) {
    if (chain.length === SUGGEST_COUNT) break;
    const last = chain[chain.length - 1];
    const gap = dayDiff(last.date, row.date);
    if (gap < SUGGEST_MIN_GAP) continue; // a second charge in the same month, not this pattern
    if (gap > SUGGEST_MAX_GAP) break; // a month was missed
    if (withinPct(parseFloat(row.amount), amount, SUGGEST_AMOUNT_PCT)) chain.push(row);
  }
  return chain.length === SUGGEST_COUNT ? chain : null;
};

const getDismissedKeys = async (dbTx = null) => {
  const keys = await readJsonSetting(SUGGESTIONS_DISMISSED_KEY, [], dbTx);
  return Array.isArray(keys) ? keys : [];
};

const findSubscriptionSuggestions = async (todayStr, dbTx = null) => {
  const [rows, running, dismissed] = await Promise.all([
    Transaction.findAll({
      where: {
        type: "EXPENSE",
        recurringGroupId: null,
        recurrence: "none",
        toAccountId: null,
        category: { [Op.ne]: "Interest" },
        amount: { [Op.gt]: 0 },
        date: { [Op.gte]: addDays(todayStr, -SUGGEST_LOOKBACK_DAYS), [Op.lte]: todayStr },
      },
      include: [{ model: Account, as: "fromAccount" }],
      order: [["date", "DESC"], ["createdAt", "DESC"]],
      transaction: dbTx,
    }),
    Transaction.findAll({
      attributes: ["title"],
      where: { type: "EXPENSE", recurrence: { [Op.in]: ACTIVE_RECURRENCES } },
      transaction: dbTx,
    }),
    getDismissedKeys(dbTx),
  ]);
  const runningKeys = new Set(running.map((r) => normalizePayeeTitle(r.title)));
  const groups = new Map();
  for (const row of rows) {
    if (row.fromAccount && row.fromAccount.type === "DEBT") continue; // debt interest and adjustments
    const key = normalizePayeeTitle(row.title);
    if (!key || runningKeys.has(key) || dismissed.includes(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const suggestions = [];
  for (const [key, group] of groups) {
    if (dayDiff(todayStr, group[0].date) > SUGGEST_MAX_AGE_DAYS) continue;
    const chain = findMonthlyChain(group);
    if (!chain) continue;
    const latest = chain[0];
    suggestions.push({
      id: latest.id,
      key,
      title: latest.title,
      amount: round2(parseFloat(latest.amount)),
      category: latest.category,
      accountName: latest.fromAccount ? latest.fromAccount.name : "Primary Checking",
      dates: chain.map((r) => r.date),
      rowIds: chain.map((r) => r.id),
      nextDate: getNextOccurrenceDate(latest.date, "monthly", 1),
    });
  }
  suggestions.sort((a, b) => b.dates[0].localeCompare(a.dates[0]));
  return suggestions;
};

/**
 * Accept: the newest row becomes a monthly series and the two older rows join it as its history.
 * The series starts generating from today on (no backfill of a month that passed since the newest
 * row). Returns { recurringGroupId }, or null when the id is not a current suggestion.
 * Generation runs after the caller commits.
 */
const acceptSubscriptionSuggestion = async (id, todayStr, dbTx) => {
  const suggestion = (await findSubscriptionSuggestions(todayStr, dbTx)).find((s) => s.id === id);
  if (!suggestion) return null;
  const recurringGroupId = crypto.randomUUID();
  const [latestId, ...olderIds] = suggestion.rowIds;
  await Transaction.update(
    { recurringGroupId },
    { where: { id: { [Op.in]: olderIds } }, transaction: dbTx }
  );
  const latest = await Transaction.findByPk(latestId, { transaction: dbTx });
  await latest.update({ recurrence: "monthly", recurringGroupId }, { transaction: dbTx });
  await markSeriesRestart(recurringGroupId, todayStr, dbTx);
  return { recurringGroupId, title: suggestion.title, nextDate: suggestion.nextDate };
};

// Dismiss: remembered by normalized title, so the same charge is not suggested again
const dismissSubscriptionSuggestion = async (id, todayStr, dbTx = null) => {
  const suggestion = (await findSubscriptionSuggestions(todayStr, dbTx)).find((s) => s.id === id);
  if (!suggestion) return false;
  const keys = await getDismissedKeys(dbTx);
  await Setting.upsert(
    { key: SUGGESTIONS_DISMISSED_KEY, value: JSON.stringify([...new Set([...keys, suggestion.key])]) },
    { transaction: dbTx }
  );
  return true;
};

module.exports = {
  recordPriceChanges,
  takePendingPriceAlerts,
  formatPriceAlert,
  findMonthlyChain,
  findSubscriptionSuggestions,
  acceptSubscriptionSuggestion,
  dismissSubscriptionSuggestion,
  PRICE_ALERTS_PENDING_KEY,
  SUGGESTIONS_DISMISSED_KEY,
};
