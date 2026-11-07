const { normalizePayeeTitle, displayPayeeTitle } = require("../utils/payeeNormalizer");

const PAYEE_HISTORY_MONTHS = 12;
const PAYEE_LIST_LIMIT = 500;

const mostUsed = (counts) => {
  let best = null;
  for (const [value, n] of counts) {
    if (!best || n > best.n) best = { value, n };
  }
  return best ? best.value : null;
};

/**
 * Quick Add's payee list: one entry per normalized title and type, from rows sorted newest first.
 * - name: the spelling you used most (a tie goes to the newer one), without dates or reference numbers
 *   ("Tim Hortons #4521" -> "Tim Hortons")
 * - category: the category used most often for that payee (a tie goes to the newer one)
 * - key: normalizePayeeTitle, the same key the Gem feed's PAYEES section uses
 * Most-used payees first, capped at PAYEE_LIST_LIMIT.
 */
const buildPayeeList = (rows = []) => {
  const byKey = new Map();
  for (const row of rows) {
    const key = normalizePayeeTitle(row.title);
    if (!key) continue;
    const type = row.type === "INCOME" ? "income" : "expense";
    const mapKey = `${type}|${key}`;
    let p = byKey.get(mapKey);
    if (!p) {
      p = { key, type, count: 0, names: new Map(), categories: new Map() };
      byKey.set(mapKey, p);
    }
    p.count += 1;
    const name = displayPayeeTitle(row.title);
    p.names.set(name, (p.names.get(name) || 0) + 1);
    const category = row.category || "Other";
    // Maps keep first-seen order (newest first), so on a tie the newer one wins in mostUsed
    p.categories.set(category, (p.categories.get(category) || 0) + 1);
  }
  return [...byKey.values()]
    .map(({ names, categories, ...p }) => ({
      ...p,
      name: mostUsed(names),
      category: mostUsed(categories) || "Other",
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, PAYEE_LIST_LIMIT);
};

module.exports = { buildPayeeList, PAYEE_HISTORY_MONTHS, PAYEE_LIST_LIMIT };
