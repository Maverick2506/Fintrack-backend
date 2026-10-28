const { normalizeTag, tagsOf } = require("./transactionTags");

// Ledger filters and the Ledger CSV download (GET /expenses/export.csv). The account text and search
// follow the frontend's Ledger (src/utils/accountRetire.js), so the file holds the rows the screen shows.

// One side of a row as the Ledger names it: Primary Checking is "Checking", archived accounts say so
const ledgerSide = (name, type, archived) => {
  if (!name) return null;
  const shown = type === "CHECKING" && name === "Primary Checking" ? "Checking" : name;
  return { name: archived ? `${shown} (archived)` : shown, type };
};

/** The row's account as the Ledger shows it: "To Amex", "From Trip", "Amex → Visa", "Checking" */
const ledgerAccountText = (row) => {
  const from = ledgerSide(row.fromAccount, row.fromAccountType, row.fromAccountArchived);
  const to = ledgerSide(row.toAccount, row.toAccountType, row.toAccountArchived);
  let line;
  if (row.type === "income") line = { from: to || from, to: null, direction: null };
  else if (from && to) {
    if (from.type === "CHECKING" && to.type !== "CHECKING") line = { from: to, to: null, direction: "to" };
    else if (to.type === "CHECKING" && from.type !== "CHECKING") line = { from, to: null, direction: "from" };
    else line = { from, to, direction: null };
  } else line = { from: from || to, to: null, direction: null };
  if (!line.from) return "";
  if (line.direction) return `${line.direction === "to" ? "To" : "From"} ${line.from.name}`;
  return line.to ? `${line.from.name} → ${line.to.name}` : line.from.name;
};

/** The Ledger's search: name, category, either account, notes or a #tag */
const matchesSearch = (row, query) => {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const sides = [
    ledgerSide(row.fromAccount, row.fromAccountType, row.fromAccountArchived),
    ledgerSide(row.toAccount, row.toAccountType, row.toAccountArchived),
  ];
  const texts = [
    row.name,
    row.category,
    row.fromAccount,
    row.toAccount,
    ledgerAccountText(row),
    row.notes,
    ...tagsOf(row).map((tag) => `#${tag}`),
    ...sides.map((side) => side?.name),
  ];
  return texts.some((text) => text && String(text).toLowerCase().includes(q));
};

const SORT_FIELDS = { date: "date", amount: "amount", name: "name" };

/**
 * Ledger rows kept by the filters, sorted like the Ledger. filters: { from, to (YYYY-MM-DD, inclusive),
 * type ("income" | "expense" | "transfer"), category, accountId (either side), tag, needsReview, search,
 * sort ("date:desc" by default) }. Rows are the GET /expenses/all shape.
 */
const filterLedgerRows = (rows, filters = {}) => {
  const tag = filters.tag ? normalizeTag(filters.tag) : "";
  let out = rows.filter(
    (r) =>
      (!filters.from || r.date >= filters.from) &&
      (!filters.to || r.date <= filters.to) &&
      (!filters.type || r.type === filters.type) &&
      (!filters.category || r.category === filters.category) &&
      (!filters.accountId || r.fromAccountId === filters.accountId || r.targetAccountId === filters.accountId) &&
      (!tag || tagsOf(r).includes(tag)) &&
      (!filters.needsReview || r.needsReview) &&
      matchesSearch(r, filters.search)
  );
  const [key = "date", dir = "desc"] = String(filters.sort || "date:desc").split(":");
  const field = SORT_FIELDS[key];
  if (field && !(field === "date" && dir === "desc")) {
    const value = (r) =>
      field === "amount" ? r.amount : field === "name" ? String(r.name || "").toLowerCase() : r.date;
    // A stable sort keeps the newest-first order among equal values
    out = [...out].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va < vb) return dir === "asc" ? -1 : 1;
      if (va > vb) return dir === "asc" ? 1 : -1;
      return 0;
    });
  }
  return out;
};

// The Ledger loads this many months at a time (GET /expenses/all without from=); "Load older" asks for more
const LEDGER_WINDOW_MONTHS = 3;

/** YYYY-MM-DD moved by whole months; the day is kept, or the month's last day when it has fewer (May 31 - 3 = Feb 28) */
const addMonthsToDateStr = (dateStr, months) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
};

/**
 * The dates GET /expenses/all reads: from=/to= as given (inclusive). Without from=, the last 3 months
 * (upcoming rows have no end unless to= is given), counted back from to= when that is before today.
 * A search or the Review inbox (needsReview) reads all history unless from= is given.
 */
const ledgerWindow = (query = {}, todayStr) => {
  const to = query.to || null;
  if (query.from) return { from: query.from, to };
  if (String(query.search || "").trim() || query.needsReview) return { from: null, to };
  const base = to && to < todayStr ? to : todayStr;
  return { from: addMonthsToDateStr(base, -LEDGER_WINDOW_MONTHS), to };
};

// A text cell a spreadsheet would run as a formula (= + - @, or a tab/CR first) gets a leading '
// A plain amount like "-12.50" or "+$2,100" stays a number in a spreadsheet; any other text that
// starts like a formula gets a leading ' so Sheets/Excel show it as text instead of running it
const PLAIN_NUMBER = /^[+-]?\$?\d[\d,]*(?:\.\d+)?%?$/;
const neutralizeFormula = (value) => {
  const str = String(value ?? "");
  return /^[=+\-@\t\r]/.test(str) && !PLAIN_NUMBER.test(str) ? `'${str}` : str;
};

const csvCell = (value) => {
  const str = String(value ?? "");
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const EXPORT_COLUMNS = ["date", "title", "type", "category", "account", "amount", "paid", "tags", "notes"];

/** The Ledger rows as CSV. Text cells are made formula-safe; date, amount and paid are written by the server. */
const ledgerCsv = (rows) => {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) {
    const text = [r.name, r.type, r.category, ledgerAccountText(r)].map(neutralizeFormula);
    lines.push(
      [
        r.date,
        text[0],
        text[1],
        text[2],
        text[3],
        (Number(r.amount) || 0).toFixed(2),
        r.is_paid ? "yes" : "no",
        neutralizeFormula(tagsOf(r).join("; ")),
        neutralizeFormula(r.notes || ""),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
};

module.exports = {
  ledgerAccountText,
  matchesSearch,
  filterLedgerRows,
  ledgerWindow,
  addMonthsToDateStr,
  LEDGER_WINDOW_MONTHS,
  neutralizeFormula,
  ledgerCsv,
  EXPORT_COLUMNS,
};
