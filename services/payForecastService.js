const { Transaction, Setting } = require("../models");
const { Op } = require("sequelize");
const { normalizePayeeTitle } = require("../utils/payeeNormalizer");
const { getNextOccurrenceDate } = require("../routes/recurring");

/**
 * Variable (hourly) pay: finds the pay series among paid income by its name, and gives the
 * forecast a cautious paycheque for it.
 * - Pay series: INCOME rows from the last PAY_LOOKBACK_DAYS days (paid, dated today or earlier),
 *   grouped by normalized title (utils/payeeNormalizer). The group with the most rows whose median
 *   gap is weekly / bi-weekly / monthly is the pay; refunds and e-transfers never shape it.
 *   Setting `pay_title` (a normalized title) picks the group instead.
 * - Amounts come from the newest PAY_ROWS rows: planningAmount is their 25th percentile (the lowest
 *   with fewer than 4), typicalAmount the median, range min to max.
 * - Expected pay (Setting `expected_pay`) bridges the gap while there's no pay series.
 */
const PAY_LOOKBACK_DAYS = 120;
const PAY_ROWS = 8;
const PAY_TITLE_KEY = "pay_title";
const EXPECTED_PAY_KEY = "expected_pay";
const PAY_CADENCES = ["weekly", "bi-weekly", "monthly"];

const DAY_MS = 24 * 60 * 60 * 1000;
const dayDiff = (a, b) => {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / DAY_MS);
};
const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
};
const roundCents = (n) => Math.round(n * 100) / 100;

const median = (nums) => {
  const s = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Inclusive linear interpolation (spreadsheet PERCENTILE / PERCENTILE.INC)
const percentile = (nums, p) => {
  const s = [...nums].sort((x, y) => x - y);
  const pos = (s.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  return s[lower] + (s[upper] - s[lower]) * (pos - lower);
};

const cadenceForGap = (gap) => {
  if (gap >= 6 && gap <= 8) return "weekly";
  if (gap >= 12 && gap <= 17) return "bi-weekly";
  if (gap >= 27 && gap <= 35) return "monthly";
  return null;
};

/**
 * Cautious paycheque from recent amounts: 25th percentile, or the lowest with fewer than 4.
 * @param {number[]} amounts
 */
const payAmounts = (amounts) => {
  const planning = amounts.length < 4 ? Math.min(...amounts) : percentile(amounts, 0.25);
  return {
    planningAmount: roundCents(planning),
    typicalAmount: roundCents(median(amounts)),
    range: { min: roundCents(Math.min(...amounts)), max: roundCents(Math.max(...amounts)) },
  };
};

// "acme payroll" -> "Acme Payroll": the payee key, readable, without the dates a raw title can carry
const payLabel = (key) => key.replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase());

/**
 * Groups income rows by normalized title and picks the pay series. Pure, so tests can feed rows.
 * A pay_title override is used only while it forms a valid series (2+ rows in the window with a
 * weekly / bi-weekly / monthly gap); otherwise it's ignored for now and automatic detection runs,
 * and overrideIgnored says why. The saved override applies again once it's valid.
 * @param {Array<{ title: string, amount: number|string, date: string }>} rows paid income, any order
 * @param {{ payTitle?: string|null }} [options]
 * @returns {{ groups: Array, pay: object|null, overrideIgnored: { title: string, label: string, reason: string }|null }}
 */
const detectPaySeries = (rows, { payTitle = null } = {}) => {
  const byKey = new Map();
  for (const row of rows) {
    const key = normalizePayeeTitle(row.title);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const groups = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const recent = list.slice(0, PAY_ROWS);
    const gaps = [];
    for (let i = 0; i < recent.length - 1; i++) gaps.push(dayDiff(recent[i].date, recent[i + 1].date));
    const cadence = gaps.length ? cadenceForGap(median(gaps)) : null;
    groups.push({
      key,
      label: payLabel(key),
      count: list.length,
      lastDate: recent[0].date,
      cadence,
      valid: recent.length >= 2 && Boolean(cadence),
      rows: recent,
    });
  }
  // Most rows first, then the most recent
  groups.sort((a, b) => b.count - a.count || (a.lastDate < b.lastDate ? 1 : -1));

  let chosen = null;
  let overrideIgnored = null;
  if (payTitle) {
    const picked = groups.find((g) => g.key === payTitle);
    if (picked && picked.valid) {
      chosen = picked;
    } else {
      const reason = !picked
        ? "no entries in the last 120 days"
        : picked.count < 2
        ? "1 entry"
        : "irregular gaps";
      overrideIgnored = { title: payTitle, label: picked ? picked.label : payLabel(payTitle), reason };
    }
  }
  if (!chosen) chosen = groups.find((g) => g.valid) || null;

  const pay = chosen
    ? {
        title: chosen.key,
        label: chosen.label,
        cadence: chosen.cadence,
        lastDate: chosen.lastDate,
        basedOn: chosen.rows.length,
        newestRow: chosen.rows[0],
        override: Boolean(payTitle) && !overrideIgnored,
        ...payAmounts(chosen.rows.map((r) => parseFloat(r.amount) || 0)),
      }
    : null;
  return { groups, pay, overrideIgnored };
};

/**
 * Expected pay dates: from nextDate by cadence, rolled forward past today when it's stale,
 * up to endDateStr. Dates on or before today are left out, like estimated paycheques.
 */
const expectedPayDates = (expected, todayStr, endDateStr) => {
  const dates = [];
  for (let step = 0; step <= 400; step++) {
    const next = step === 0 ? expected.nextDate : getNextOccurrenceDate(expected.nextDate, expected.cadence, step);
    if (!next || next > endDateStr) break;
    if (next > todayStr) dates.push(next);
  }
  return dates;
};

const parseExpectedPay = (record) => {
  if (!record || !record.value) return null;
  try {
    const v = JSON.parse(record.value);
    if (!v || !v.nextDate || !PAY_CADENCES.includes(v.cadence) || !(parseFloat(v.amount) > 0)) return null;
    return { nextDate: v.nextDate, cadence: v.cadence, amount: roundCents(parseFloat(v.amount)) };
  } catch {
    return null;
  }
};

/**
 * Loads paid income to Checking from the last PAY_LOOKBACK_DAYS days and runs detectPaySeries,
 * plus the pay_title and expected_pay Settings.
 */
const loadPayContext = async ({ todayStr, checkingId, dbTx = null }) => {
  const since = addDays(todayStr, -PAY_LOOKBACK_DAYS);
  const [rows, payTitleRec, expectedRec] = await Promise.all([
    Transaction.findAll({
      where: {
        type: "INCOME",
        isCleared: true,
        date: { [Op.gte]: since, [Op.lte]: todayStr },
        [Op.or]: [{ toAccountId: checkingId }, { toAccountId: null }],
      },
      order: [["date", "DESC"]],
      transaction: dbTx,
    }),
    Setting.findByPk(PAY_TITLE_KEY, { transaction: dbTx }),
    Setting.findByPk(EXPECTED_PAY_KEY, { transaction: dbTx }),
  ]);
  const payTitle = payTitleRec && payTitleRec.value ? payTitleRec.value : null;
  const { groups, pay, overrideIgnored } = detectPaySeries(rows, { payTitle });
  return { groups, pay, overrideIgnored, payTitle, expectedPay: parseExpectedPay(expectedRec) };
};

module.exports = {
  PAY_LOOKBACK_DAYS,
  PAY_ROWS,
  PAY_TITLE_KEY,
  EXPECTED_PAY_KEY,
  PAY_CADENCES,
  percentile,
  payAmounts,
  payLabel,
  detectPaySeries,
  expectedPayDates,
  parseExpectedPay,
  loadPayContext,
};
