/**
 * Merchant name normalizer for transaction lookups and category caching.
 * Normalizes strings like "UBER *TRIP 8H2K" -> "uber trip", "Tim Hortons #1234" -> "tim hortons".
 */
const normalizeMerchantName = (rawName) => {
  if (!rawName || typeof rawName !== "string") return "";

  let cleaned = rawName.toLowerCase().trim();

  // Strip common transaction artifacts and card noise
  cleaned = cleaned
    .replace(/\*trip\s*[a-z0-9]+/gi, "") // Uber *TRIP 8H2K
    .replace(/\*[a-z0-9]+/gi, "") // *TRIP, *PAY, etc.
    .replace(/#\s*\d+/g, "") // #1234
    .replace(/\b(store|branch|loc|location|unit|station)\s*#?\d+\b/gi, "") // store 3044
    .replace(/\b(online|pos|auth|purchase|autopay|bill\s*pay)\b/gi, "") // banking noise
    .replace(/\b(ca|canada|us|usa|toronto|mississauga|vancouver|montreal)\b/gi, "") // regional tags
    .replace(/\b(inc|llc|corp|ltd|co)\b/gi, "") // corporate suffixes
    .replace(/\.com(\.?[a-z]{2,3})?/gi, "") // .com, .ca
    .replace(/\b\d{3,}\b/g, "") // long digit strings (terminal/store IDs)
    .replace(/[^\w\s&'-]/g, " ") // replace unusual punctuation
    .replace(/\s+/g, " ") // collapse whitespaces
    .trim();

  return cleaned || rawName.toLowerCase().trim();
};

module.exports = {
  normalizeMerchantName,
};
