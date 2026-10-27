const { Rule } = require("../models");

// Rules in the order they apply: lowest priority number first, then the oldest
const loadRules = (dbTx = null) =>
  Rule.findAll({
    order: [
      ["priority", "ASC"],
      ["createdAt", "ASC"],
    ],
    transaction: dbTx,
  });

// What the rules say about a title: { category, accountId, categoryRuleId, accountRuleId }.
// A rule matches when the title contains its text, ignoring case. Each field comes from the first
// matching rule (in priority order) that sets it, so a rule can set only the category or only the account.
const applyRules = (rules, title) => {
  const t = String(title || "").toLowerCase();
  const result = { category: null, accountId: null, categoryRuleId: null, accountRuleId: null };
  for (const rule of rules) {
    const needle = String(rule.match || "").trim().toLowerCase();
    if (!needle || !t.includes(needle)) continue;
    if (!result.category && rule.category) {
      result.category = rule.category;
      result.categoryRuleId = rule.id;
    }
    if (!result.accountId && rule.accountId) {
      result.accountId = rule.accountId;
      result.accountRuleId = rule.id;
    }
    if (result.category && result.accountId) break;
  }
  return result;
};

module.exports = { loadRules, applyRules };
