/**
 * Canonical list of expense categories across FinTrack.
 * Must match frontend CATEGORY_CONFIG and quickAddParser.
 */
const EXPENSE_CATEGORIES = [
  "Essentials",
  "Food & Drink",
  "Shopping",
  "Subscription",
  "Transportation",
  "Entertainment",
  "Debt",
  "Other",
];

const ALL_CATEGORIES = [...EXPENSE_CATEGORIES, "Income"];

/**
 * Categories the app itself writes (income, interest sweep, Sync with statement, goal
 * contributions, refunds, card and debt payments). Not offered in pickers.
 */
const SYSTEM_CATEGORIES = [
  "Income",
  "Interest",
  "Adjustment",
  "Savings Transfer",
  "Refund",
  "Credit Card Payment",
  "Debt Payment",
];

/** Every category POST /expenses accepts. */
const TRANSACTION_CATEGORIES = [...EXPENSE_CATEGORIES, ...SYSTEM_CATEGORIES];

/** The canonical spelling of a category, matched without regard to case or extra spaces; null if unknown. */
const canonicalCategory = (value) => {
  const wanted = String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return TRANSACTION_CATEGORIES.find((c) => c.toLowerCase() === wanted) || null;
};

module.exports = {
  EXPENSE_CATEGORIES,
  ALL_CATEGORIES,
  SYSTEM_CATEGORIES,
  TRANSACTION_CATEGORIES,
  canonicalCategory,
};
