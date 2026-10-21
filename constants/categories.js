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

module.exports = {
  EXPENSE_CATEGORIES,
  ALL_CATEGORIES,
};
