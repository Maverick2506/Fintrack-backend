const { EXPENSE_CATEGORIES } = require("../constants/categories");

// POST /categorize-receipt: what a photo may be, and how Gemini's reading becomes a draft.
// Nothing here saves anything; the app fills its form from the draft and the user saves it.

const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

// The photo's type from its first bytes (the browser's Content-Type is only a claim)
const sniffImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  // HEIC/HEIF (iPhone photos): an ISO box "ftyp" at byte 4 with a HEIF brand
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return null;
};

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]);

const toMoney = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
};

const isRealDate = (str) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(str || ""))) return false;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * Gemini's reading of a receipt as a draft the app can show. The server decides what is usable:
 * - amount: the total, over 0 and at most $100,000, to the cent; else null
 * - taxAmount: 0 up to the total (and only with a total); else null
 * - date: a real day from 2000 to today (Toronto); else null (the app uses today)
 * - merchant: plain text, at most 100 characters
 * - category: one of the app's expense categories; the user's rules on the merchant come first
 * ruled is applyRules(rules, merchant): { category, accountId }.
 */
const cleanReceiptDraft = (raw = {}, { todayStr, ruled = {} } = {}) => {
  const amount = toMoney(raw.amount);
  const okAmount = amount !== null && amount > 0 && amount <= 100000 ? amount : null;
  const tax = toMoney(raw.taxAmount);
  const taxAmount = okAmount !== null && tax !== null && tax >= 0 && tax <= okAmount ? tax : null;
  const date = isRealDate(raw.date) && raw.date >= "2000-01-01" && (!todayStr || raw.date <= todayStr) ? raw.date : null;
  const merchant =
    String(raw.merchant || "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || null;
  let category = EXPENSE_CATEGORIES.includes(raw.category) ? raw.category : "Other";
  let categorySource = "ai";
  if (ruled.category && EXPENSE_CATEGORIES.includes(ruled.category)) {
    category = ruled.category;
    categorySource = "rule";
  }
  return {
    amount: okAmount,
    merchant,
    date,
    taxAmount,
    category,
    categorySource,
    accountId: ruled.accountId || null,
  };
};

module.exports = { RECEIPT_MAX_BYTES, ALLOWED_MIME_TYPES, sniffImageType, cleanReceiptDraft };
