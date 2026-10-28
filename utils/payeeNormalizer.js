/**
 * Payee key for the export feed's PAYEES section: "Hydro Oct", "hydro 10/15" and
 * "HYDRO" all become "hydro" so a bill's history lands on one row.
 * 1. lowercase, trim, collapse spaces (accents dropped: "Café" -> "cafe")
 * 2. remove dates: 10/22, 10-22, 2026-10-22, "oct 22", and month names on their own
 * 3. remove reference numbers: "#4521", "no. 12", "ref 889", standalone numbers of 3+ digits
 * 4. keep digits inside a word or in a short standalone number: "7-eleven", "3m", "99 ranch"
 * 5. strip punctuation left behind at the ends
 */
const MONTH_WORDS =
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

// Not touching a letter or digit, so "marche" or "3m" never count as a boundary
const B = "(?<![\\p{L}\\d])";
const E = "(?![\\p{L}\\d])";

const ISO_DATE = new RegExp(`${B}\\d{4}-\\d{1,2}-\\d{1,2}${E}`, "gu");
const NUMERIC_DATE = new RegExp(`${B}\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?${E}`, "gu");
// "oct", "oct.", "oct 22", "october 22nd, 2026"
const MONTH_DATE = new RegExp(
  `${B}(?:${MONTH_WORDS})${E}\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?${E})?(?:,?\\s+\\d{4}${E})?`,
  "gu"
);
const HASH_REF = /#\s*[\p{L}\d-]*/gu;
const WORD_REF = new RegExp(`${B}(?:no\\.|ref)\\s*[#:.]?\\s*[\\p{L}\\d-]*\\d[\\p{L}\\d-]*`, "gu");
const LONG_NUMBER = new RegExp(`${B}\\d{3,}${E}`, "gu");

const normalizePayeeTitle = (rawTitle) => {
  if (!rawTitle || typeof rawTitle !== "string") return "";
  const fallback = rawTitle.toLowerCase().replace(/\s+/g, " ").trim();

  const cleaned = fallback
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(ISO_DATE, " ")
    .replace(NUMERIC_DATE, " ")
    .replace(MONTH_DATE, " ")
    .replace(HASH_REF, " ")
    .replace(WORD_REF, " ")
    .replace(LONG_NUMBER, " ")
    // Keep letters, digits, spaces and the & ' . - that live inside names
    .replace(/[^\p{L}\d\s&'.-]/gu, " ")
    .split(/\s+/)
    // Drop tokens that are only leftover punctuation (a lone "&" stays: "a & w")
    .filter((token) => token && (token === "&" || /[\p{L}\d]/u.test(token)))
    .join(" ")
    .replace(/^[\s&'.-]+|[\s&'.-]+$/g, "");

  return cleaned || fallback;
};

// The same date, reference and long-number tokens in any case, for display names
const ci = (re) => new RegExp(re.source, "giu");
const PHONE = new RegExp(`${B}\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]\\d{4}${E}`, "gu");

/**
 * A payee name to show and to title a new series with: "Spotify 10/22" -> "Spotify",
 * "NETFLIX.COM 866-579-7172" -> "NETFLIX.COM", "Hydro #4521 Oct 2026" -> "Hydro". Removes what
 * normalizePayeeTitle removes (dates, references, long numbers, phone numbers) but keeps the casing
 * and spacing of the rest. Falls back to the trimmed title when nothing would be left.
 */
const displayPayeeTitle = (rawTitle) => {
  if (!rawTitle || typeof rawTitle !== "string") return "";
  const fallback = rawTitle.replace(/\s+/g, " ").trim();
  const cleaned = fallback
    .replace(PHONE, " ")
    .replace(ci(ISO_DATE), " ")
    .replace(ci(NUMERIC_DATE), " ")
    .replace(ci(MONTH_DATE), " ")
    .replace(ci(HASH_REF), " ")
    .replace(ci(WORD_REF), " ")
    .replace(ci(LONG_NUMBER), " ")
    .split(/\s+/)
    .filter((token) => token && (token === "&" || /[\p{L}\d]/u.test(token)))
    .join(" ")
    .replace(/^[\s&'.,*:/-]+|[\s&',*:/-]+$/g, "");
  return cleaned || fallback;
};

module.exports = { normalizePayeeTitle, displayPayeeTitle };
