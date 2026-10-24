const crypto = require("crypto");
const { toZonedTime, format } = require("date-fns-tz");
const { getNextOccurrenceDate } = require("../routes/recurring");

// Debt interest (R2): on each due date, before the payment, a debt's balance grows by one period of
// interest. The daily sweep records it, and the forecast and payoff planner project it the same way.

const round2 = (n) => Math.round(n * 100) / 100;

const DEBT_INTEREST_SETTING_KEY = "debt_interest_enabled";
// Date of the first sweep with interest. Due dates before it (a manual debt whose due date was never
// moved on) advance without interest, so the first run after deploy does not charge missed months.
const DEBT_INTEREST_START_KEY = "debt_interest_start_date";

const PERIODS_PER_YEAR = {
  weekly: 52,
  "bi-weekly": 26,
  monthly: 12,
  yearly: 1,
};

const hasInterestRate = (apr) => {
  const rate = parseFloat(apr);
  return !isNaN(rate) && rate > 0;
};

// One period of interest: round(balance × APR/100 / 12, 2) for monthly, scaled for other frequencies
const computePeriodInterest = (balance, apr, frequency = "monthly") => {
  const bal = parseFloat(balance) || 0;
  if (bal <= 0 || !hasInterestRate(apr)) return 0;
  const periods = PERIODS_PER_YEAR[frequency] || 12;
  return round2((bal * parseFloat(apr)) / 100 / periods);
};

// Day of month the debt is meant to fall on (dueDay), or the due date's own day for older rows
const getDebtAnchorDay = (debt) => {
  const stored = parseInt(debt.dueDay, 10);
  if (stored >= 1 && stored <= 31) return stored;
  if (!debt.dueDate) return null;
  return parseInt(String(debt.dueDate).split("-")[2], 10) || null;
};

// Next due date with month-end clamping that returns to the anchor day: 31 -> Feb 28 -> Mar 31 (R3)
const getNextDebtDueDate = (dueDate, frequency, anchorDay) =>
  getNextOccurrenceDate(dueDate, frequency || "monthly", 1, anchorDay || null);

// Interest rows are idempotent through the unique clientRef index (transactions_client_ref_unique,
// created in server initialize() on Postgres and SQLite). clientRef is a UUID column, so the key
// "interest:<debtId>:<dueDate>" becomes a UUIDv5 (RFC 4122, SHA-1) in a fixed FinTrack namespace:
// the same debt and due date always give the same UUID. Never change this namespace, or interest
// already recorded would no longer be recognised.
const INTEREST_UUID_NAMESPACE = "3f6c2b8e-5d4a-4e1b-9c7f-2a8d6e0b4c91";

const uuidV5 = (name, namespace) => {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")])).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const interestClientRef = (debtId, dueDate) =>
  uuidV5(`interest:${debtId}:${dueDate}`, INTEREST_UUID_NAMESPACE);

// Due date one period before (anchored like getNextDebtDueDate)
const getPreviousDebtDueDate = (dueDate, frequency, anchorDay) =>
  getNextOccurrenceDate(dueDate, frequency || "monthly", -1, anchorDay || null);

// Rows paid TO a debt that count as a payment. A statement-sync Adjustment down (a payment made at
// the bank, then synced) counts; an "Interest" row paid to a debt is an old mislabelled sync, not a payment.
const NOT_A_PAYMENT_CATEGORIES = ["Interest"];

/**
 * Missed payment (Debts page): the due date that most recently passed (before today) had no cleared
 * payment to the debt between the due date before it and today. Returns that due date, or null.
 * payments: [{ date, category }] of cleared rows paid to this debt (toAccountId = the debt).
 */
const findMissedPayment = (debt, payments, todayStr) => {
  if (!debt.dueDate || debt.isActive === false || !((parseFloat(debt.initialBalance) || 0) > 0)) {
    return null;
  }
  const frequency = debt.paymentFrequency || "monthly";
  const anchorDay = getDebtAnchorDay(debt);
  const lastDue =
    debt.dueDate < todayStr ? debt.dueDate : getPreviousDebtDueDate(debt.dueDate, frequency, anchorDay);
  // On the due day itself the payment may still come; a debt added after it never had that due date
  if (!lastDue || lastDue >= todayStr) return null;
  const createdStr = debt.createdAt
    ? format(toZonedTime(new Date(debt.createdAt), "America/Toronto"), "yyyy-MM-dd")
    : null;
  if (createdStr && lastDue < createdStr) return null;
  const windowStart = getPreviousDebtDueDate(lastDue, frequency, anchorDay);
  const paid = payments.some(
    (p) => !NOT_A_PAYMENT_CATEGORIES.includes(p.category) && p.date > windowStart && p.date <= todayStr
  );
  return paid ? null : lastDue;
};

const interestTitle = (debtName) => `Interest – ${debtName}`;

/**
 * Projects a debt's due dates between fromDate and toDate (inclusive) the way the daily sweep runs
 * them: interest first (when enabled), then the auto-pay of min(balance, minimum payment).
 * handledFor(dueDate) returns { interest, payment } for rows the sweep already recorded on that due
 * date, so they are not projected twice.
 */
const projectDebtSchedule = ({
  balance,
  apr,
  minimumPayment,
  autoPay,
  dueDate,
  dueDay,
  frequency = "monthly",
  fromDate,
  toDate,
  interestEnabled = true,
  interestStartDate = null,
  handledFor = () => ({}),
}) => {
  const schedule = [];
  let bal = round2(parseFloat(balance) || 0);
  const minPay = parseFloat(minimumPayment) || 0;
  const anchorDay = getDebtAnchorDay({ dueDate, dueDay });
  let curDue = dueDate;
  let guard = 0;
  while (curDue && curDue <= toDate && bal > 0 && guard++ < 600) {
    if (curDue >= fromDate) {
      const done = handledFor(curDue) || {};
      let interest = 0;
      if (
        interestEnabled &&
        !done.interest &&
        (!interestStartDate || curDue >= interestStartDate)
      ) {
        interest = computePeriodInterest(bal, apr, frequency);
        bal = round2(bal + interest);
      }
      let payment = 0;
      if (autoPay && minPay > 0 && !done.payment) {
        payment = round2(Math.min(bal, minPay));
        bal = round2(Math.max(0, bal - payment));
      }
      schedule.push({ date: curDue, interest, payment, balance: bal });
      // An auto-pay debt stops once the sweep turns auto-pay off at $0
      if (autoPay && bal <= 0) break;
    }
    curDue = getNextDebtDueDate(curDue, frequency, anchorDay);
  }
  return schedule;
};

const isDebtInterestEnabled = async (Setting, dbTx = null) => {
  const record = await Setting.findByPk(DEBT_INTEREST_SETTING_KEY, { transaction: dbTx });
  return record ? record.value !== "false" : true;
};

const DUE_DAY_BACKFILL_KEY = "debt_due_day_backfilled_v1";

// One-off (Setting flag): store each debt's due day from its due date. A debt that already drifted
// (31st -> 28th) keeps the 28th until the user sets its due date again. Runs from server initialize().
const backfillDebtDueDays = async (Account, Setting) => {
  const done = await Setting.findByPk(DUE_DAY_BACKFILL_KEY);
  if (done && done.value === "true") return 0;
  const debts = await Account.findAll({ where: { type: "DEBT", dueDay: null } });
  let count = 0;
  for (const debt of debts) {
    const day = getDebtAnchorDay(debt);
    if (day) {
      await debt.update({ dueDay: day }, { fields: ["dueDay"] });
      count++;
    }
  }
  if (count > 0) console.log(`✅ Backfilled dueDay on ${count} debts.`);
  await Setting.upsert({ key: DUE_DAY_BACKFILL_KEY, value: "true" });
  return count;
};

module.exports = {
  DUE_DAY_BACKFILL_KEY,
  backfillDebtDueDays,
  DEBT_INTEREST_SETTING_KEY,
  DEBT_INTEREST_START_KEY,
  PERIODS_PER_YEAR,
  computePeriodInterest,
  getDebtAnchorDay,
  getNextDebtDueDate,
  interestClientRef,
  interestTitle,
  uuidV5,
  INTEREST_UUID_NAMESPACE,
  getPreviousDebtDueDate,
  findMissedPayment,
  projectDebtSchedule,
  isDebtInterestEnabled,
  hasInterestRate,
};
