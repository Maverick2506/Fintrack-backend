/**
 * Merchant name normalizer for transaction lookups and category caching.
 * Normalizes merchant names while preserving distinctions between sub-brands
 * (e.g. "Uber Trip" vs "Uber Eats", "Co-op", "US Bank").
 */
const normalizeMerchantName = (rawName) => {
  if (!rawName || typeof rawName !== "string") return "";

  let cleaned = rawName.toLowerCase().trim();

  // 1. Strip known payment-processor prefixes (Square, Toast, PayPal, Stripe, etc.)
  cleaned = cleaned.replace(/^(sq|tst|paypal|sp)\s*\*?\s*/i, "");

  // 2. Replace '*' with a space instead of deleting what comes after it
  cleaned = cleaned.replace(/\*/g, " ");

  // 3. Strip alphanumeric reference/transaction codes (mixed letters and digits, 4+ chars)
  // e.g. "8h2k", "2k4l", "ref12345", "tx99a"
  cleaned = cleaned.replace(/\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*[0-9])[a-z0-9]{4,}\b/gi, "");

  // 4. Strip store / location numbers: "#1234", "store #3044", "# 567"
  cleaned = cleaned.replace(/#\s*\d+/g, "");
  cleaned = cleaned.replace(/\b(store|branch|loc|station)\s*#?\s*\d+\b/gi, "");

  // 5. Strip isolated long numbers (terminal/store IDs, 3+ digits)
  cleaned = cleaned.replace(/\b\d{3,}\b/g, "");

  // 6. Strip domain extensions (.com, .ca, .org)
  cleaned = cleaned.replace(/\.(com|ca|org|net|io|co)\b/gi, "");

  // Intermediate trim & whitespace collapse
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // 7. Strip corporate suffixes ONLY at the very end of the string (not at start, e.g. "Co-op")
  cleaned = cleaned.replace(/\s+(inc|ltd|llc|corp|corporation)\.?$/gi, "");

  // 8. Strip trailing country/regional markers only at the very end (not at start, e.g. "US Bank")
  cleaned = cleaned.replace(/\s+(ca|canada|usa?)\.?$/gi, "");

  // 9. Replace punctuation except hyphens/apostrophes within words with space
  cleaned = cleaned.replace(/[^\w\s'-]/g, " ");

  // 10. Final collapse multiple spaces & trim
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned || rawName.toLowerCase().trim();
};

module.exports = {
  normalizeMerchantName,
};
