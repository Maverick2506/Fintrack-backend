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
    // Drop accents first, so "Café" stays "cafe" and "Marché" isn't read as "march"
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // ISO dates and numeric dates like 10/15, 10-15-2026
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    .replace(new RegExp(`(?<![\\p{L}])(?:${MONTH_WORDS})(?![\\p{L}])\\.?`, "gu"), " ")
    .replace(/\d+/g, " ")
    // Keep letters (any language), spaces, & ' and - only
    .replace(/[^\p{L}\s&'-]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s&'-]+|[\s&'-]+$/g, "")
    .trim();

  return cleaned || fallback;
};

module.exports = { normalizePayeeTitle };
