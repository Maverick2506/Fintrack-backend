// Bank and card CSV import: parsing, column mapping and title matching. Pure functions, no database.

const crypto = require("crypto");

const MAX_IMPORT_ROWS = 2000;
const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "DD-MMM-YYYY", "MMM DD, YYYY"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

class CsvError extends Error {}

// RFC 4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, BOM.
// Blank lines are dropped. Throws CsvError on an unclosed quote or a binary file.
const parseCsv = (text) => {
  if (typeof text !== "string") throw new CsvError("The file is not text.");
  if (text.includes("\u0000")) throw new CsvError("The file is not a CSV (it looks like a binary file).");
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field.trim() === "") {
      field = "";
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new CsvError("The file has a quote that is never closed.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows
    .map((r) => r.map((f) => f.trim()))
    .filter((r) => r.some((f) => f !== ""));
};

const pad2 = (n) => String(n).padStart(2, "0");

const validYmd = (y, m, d) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
};

// Parses a bank date into YYYY-MM-DD, or null. Day-first and month-first formats are explicit
// because 03/04/2026 means different days at different banks.
const parseDate = (raw, format) => {
  const s = String(raw || "").trim();
  let m;
  switch (format) {
    case "YYYY-MM-DD":
      m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      return m ? validYmd(+m[1], +m[2], +m[3]) : null;
    case "YYYY/MM/DD":
      m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      return m ? validYmd(+m[1], +m[2], +m[3]) : null;
    case "MM/DD/YYYY":
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m ? validYmd(+m[3], +m[1], +m[2]) : null;
    case "DD/MM/YYYY":
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m ? validYmd(+m[3], +m[2], +m[1]) : null;
    case "DD-MMM-YYYY": {
      m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{4})$/);
      const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
      return m && mon ? validYmd(+m[3], mon, +m[1]) : null;
    }
    case "MMM DD, YYYY": {
      m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
      const mon = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
      return m && mon ? validYmd(+m[3], mon, +m[2]) : null;
    }
    default:
      return null;
  }
};

// "$1,234.56", "-12.30", "(12.30)", "12.30-", "1 234,56" is not supported. Returns a number or null.
const parseAmount = (raw) => {
  let s = String(raw || "").trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/^(CAD|USD)\s*/i, "").replace(/[$\s]/g, "").replace(/,/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100) / 100;
  return negative ? -n : n;
};

const looksLikeHeader = (row) =>
  row.length > 0 &&
  row.every((f) => parseAmount(f) === null && !DATE_FORMATS.some((fmt) => parseDate(f, fmt)));

// The date format that reads every non-empty value in the column (the first one listed wins a tie)
const detectDateFormat = (values) => {
  const filled = values.filter((v) => String(v || "").trim() !== "");
  if (filled.length === 0) return null;
  const fits = DATE_FORMATS.filter((fmt) => filled.every((v) => parseDate(v, fmt)));
  if (fits.length === 0) return null;
  // Both month-first and day-first fit when every day is 12 or less; prefer month-first (TD, RBC exports)
  return fits[0];
};

const headerIndex = (headers, patterns) =>
  headers.findIndex((h) => patterns.some((p) => p.test(h)));

// A best guess at the mapping from the file itself: header names when there is a header row,
// the shape of the values otherwise. The user can change every field before importing.
const suggestMapping = (rows) => {
  if (rows.length === 0) return null;
  const hasHeader = looksLikeHeader(rows[0]);
  const body = hasHeader ? rows.slice(1) : rows;
  const width = Math.max(...rows.map((r) => r.length));
  const column = (i) => body.map((r) => r[i] || "");
  const headers = hasHeader ? rows[0].map((h) => h.toLowerCase()) : [];

  let date = hasHeader ? headerIndex(headers, [/transaction date/, /^date/, /date/]) : -1;
  if (date < 0) {
    for (let i = 0; i < width; i++) {
      if (detectDateFormat(column(i))) {
        date = i;
        break;
      }
    }
  }
  const isNumeric = (i) => {
    const vals = column(i).filter((v) => v !== "");
    return vals.length > 0 && vals.every((v) => parseAmount(v) !== null);
  };

  let description = [];
  let amount = -1;
  let debit = -1;
  let credit = -1;
  if (hasHeader) {
    const d1 = headerIndex(headers, [/description 1/, /^description/, /description|merchant|payee|details|name/]);
    if (d1 >= 0) description.push(d1);
    const d2 = headerIndex(headers, [/description 2/]);
    if (d2 >= 0 && d2 !== d1) description.push(d2);
    debit = headerIndex(headers, [/debit|withdrawal|money out|paid out/]);
    credit = headerIndex(headers, [/credit|deposit|money in|paid in/]);
    amount = headerIndex(headers, [/^amount/, /cad\$/, /amount/]);
  }
  if (description.length === 0) {
    const text = [];
    for (let i = 0; i < width; i++) {
      if (i !== date && !isNumeric(i) && column(i).some((v) => v !== "")) text.push(i);
    }
    if (text.length > 0) description = [text[0]];
  }
  if (amount < 0 && (debit < 0 || credit < 0)) {
    const numeric = [];
    for (let i = 0; i < width; i++) {
      if (i !== date && !description.includes(i) && isNumeric(i)) numeric.push(i);
    }
    // Two or more number columns with blanks (TD: debit, credit, balance): debit and credit
    const withBlanks = numeric.filter((i) => column(i).some((v) => v === ""));
    if (withBlanks.length >= 2) {
      debit = withBlanks[0];
      credit = withBlanks[1];
    } else if (numeric.length > 0) {
      amount = numeric[0];
      debit = -1;
      credit = -1;
    }
  }
  const mapping = {
    hasHeader,
    date: date >= 0 ? date : 0,
    description: description.length > 0 ? description : [1],
    dateFormat: (date >= 0 && detectDateFormat(column(date))) || "YYYY-MM-DD",
    outflow: "negative",
  };
  if (amount >= 0 && !(debit >= 0 && credit >= 0)) mapping.amount = amount;
  else if (debit >= 0 && credit >= 0) {
    mapping.debit = debit;
    mapping.credit = credit;
  } else mapping.amount = width > 2 ? 2 : width - 1;
  return mapping;
};

// The column names shown in the mapping step: the header row, or "Column 1", "Column 2", ...
const columnNames = (rows, hasHeader) => {
  const width = rows.length ? Math.max(...rows.map((r) => r.length)) : 0;
  return Array.from({ length: width }, (_, i) =>
    hasHeader && rows[0][i] ? rows[0][i] : `Column ${i + 1}`
  );
};

// Applies a mapping to the parsed rows. Returns { rows, invalid } where each row is
// { line, date, description, amount, direction: "out" | "in" } with amount > 0, and invalid lists
// { line, reason } for lines that couldn't be read (a footer, a blank amount).
// Throws CsvError when a mapped column is outside the file or nothing at all could be read.
const applyMapping = (rows, mapping) => {
  const width = rows.length ? Math.max(...rows.map((r) => r.length)) : 0;
  const cols = [mapping.date, ...mapping.description];
  if (mapping.amount !== undefined && mapping.amount !== null) cols.push(mapping.amount);
  else cols.push(mapping.debit, mapping.credit);
  if (cols.some((c) => c === undefined || c === null || c < 0 || c >= width)) {
    throw new CsvError("The column mapping points at a column the file doesn't have.");
  }
  const body = mapping.hasHeader ? rows.slice(1) : rows;
  const startLine = mapping.hasHeader ? 2 : 1;
  if (body.length > MAX_IMPORT_ROWS) {
    throw new CsvError(`The file has ${body.length} rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString("en-CA")}.`);
  }
  const out = [];
  const invalid = [];
  body.forEach((r, i) => {
    const line = startLine + i;
    const date = parseDate(r[mapping.date], mapping.dateFormat);
    const description = mapping.description
      .map((c) => r[c] || "")
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 255);
    let signed = null;
    if (mapping.amount !== undefined && mapping.amount !== null) {
      const a = parseAmount(r[mapping.amount]);
      if (a !== null) signed = mapping.outflow === "positive" ? -a : a;
    } else {
      const d = parseAmount(r[mapping.debit]);
      const c = parseAmount(r[mapping.credit]);
      if (d !== null || c !== null) signed = Math.round(((c || 0) - Math.abs(d || 0)) * 100) / 100;
    }
    if (!date) return invalid.push({ line, reason: "date not readable" });
    if (!description) return invalid.push({ line, reason: "no description" });
    if (signed === null) return invalid.push({ line, reason: "amount not readable" });
    if (signed === 0) return invalid.push({ line, reason: "amount is $0" });
    out.push({
      line,
      date,
      description,
      amount: Math.abs(signed),
      direction: signed < 0 ? "out" : "in",
    });
  });
  if (out.length === 0) {
    throw new CsvError(
      invalid.length > 0
        ? `No rows could be read with this mapping (line ${invalid[0].line}: ${invalid[0].reason}).`
        : "The file has no rows to import."
    );
  }
  return { rows: out, invalid };
};

// clientRef of an imported row: sha256(accountId|date|amount|description), shaped as a UUID
// (version 8, "custom") because Transactions.clientRef is a UUID column. A second identical row in
// the same file (two $4.50 coffees on one day) appends "|2", so it imports too and a re-import still
// finds both.
const importClientRef = (accountId, date, amount, description, occurrence = 1) => {
  const key = [accountId, date, Number(amount).toFixed(2), description.trim().toLowerCase()];
  if (occurrence > 1) key.push(String(occurrence));
  const hex = crypto.createHash("sha256").update(key.join("|")).digest("hex").slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// Numbers each row's repeat within the file: the first "TIM HORTONS 4.50 2026-04-02" is 1, the next 2
const withOccurrences = (rows) => {
  const seen = new Map();
  return rows.map((r) => {
    const key = `${r.date}|${r.amount.toFixed(2)}|${r.direction}|${r.description.toLowerCase()}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return { ...r, occurrence: n };
  });
};

// Words that say nothing about who was paid, ignored when comparing titles
const GENERIC_WORDS = new Set([
  "payment", "purchase", "pos", "transfer", "bill", "debit", "credit", "online", "the", "and", "for",
  "inc", "ltd", "com", "www", "thank", "you", "auto", "pay", "pre", "authorized", "interac", "etransfer",
]);

const titleWords = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));

// "Netflix" and "NETFLIX.COM 866-579-7172" are similar; "Rent" and "E-TRANSFER JOHN" are not.
// Similar when one title's letters contain the other's, or they share a word of 3+ letters
// (generic words like "payment" or "bill" don't count for either).
const titlesSimilar = (a, b) => {
  const flat = (s) => titleWords(s).join("");
  const fa = flat(a);
  const fb = flat(b);
  if (fa.length >= 4 && fb.length >= 4 && (fa.includes(fb) || fb.includes(fa))) return true;
  const wb = new Set(titleWords(b));
  return titleWords(a).some((w) => wb.has(w));
};

const daysBetween = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

module.exports = {
  CsvError,
  DATE_FORMATS,
  MAX_IMPORT_ROWS,
  parseCsv,
  parseDate,
  parseAmount,
  detectDateFormat,
  suggestMapping,
  columnNames,
  applyMapping,
  importClientRef,
  withOccurrences,
  titlesSimilar,
  daysBetween,
};
