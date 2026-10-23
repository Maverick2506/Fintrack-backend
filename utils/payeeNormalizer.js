/**
 * Payee key for the export feed's PAYEES section: "Hydro Oct", "hydro 10/15" and
 * "HYDRO" all become "hydro" so a bill's history lands on one row.
 * Lowercase, trimmed, with dates, month names and digits removed.
 */
const MONTH_WORDS =
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

const normalizePayeeTitle = (rawTitle) => {
  if (!rawTitle || typeof rawTitle !== "string") return "";
  const fallback = rawTitle.toLowerCase().trim();

  const cleaned = fallback
    // ISO dates and numeric dates like 10/15, 10-15-2026
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    .replace(new RegExp(`\\b(?:${MONTH_WORDS})(?![a-z])\\.?`, "g"), " ")
    .replace(/\d+/g, " ")
    // Keep letters, spaces, & ' and - only
    .replace(/[^a-z\s&'-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s&'-]+|[\s&'-]+$/g, "")
    .trim();

  return cleaned || fallback;
};

module.exports = { normalizePayeeTitle };
