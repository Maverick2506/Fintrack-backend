const crypto = require("crypto");

const isProd = process.env.NODE_ENV === "production";

const SUPER_SECRET_PASSWORD =
  process.env.SUPER_SECRET_PASSWORD || "maverick";

// If JWT_SECRET is explicitly set, use it. Otherwise, auto-derive a cryptographically distinct
// 256-bit signing key from SUPER_SECRET_PASSWORD using HMAC-SHA256 so deployments on Render
// never crash due to a missing JWT_SECRET environment variable.
const JWT_SECRET =
  process.env.JWT_SECRET ||
  crypto
    .createHmac("sha256", "fintrack-jwt-signing-salt-v1")
    .update(SUPER_SECRET_PASSWORD)
    .digest("hex");

const isDevBypassAllowed = () => {
  if (isProd) return false;
  return process.env.ALLOW_DEV_BYPASS === "true";
};

const verifyPassword = (inputPassword) => {
  if (!SUPER_SECRET_PASSWORD || typeof inputPassword !== "string") {
    return false;
  }
  const inputHash = crypto.createHash("sha256").update(inputPassword).digest();
  const targetHash = crypto
    .createHash("sha256")
    .update(SUPER_SECRET_PASSWORD)
    .digest();
  return crypto.timingSafeEqual(inputHash, targetHash);
};

const assertAuthConfiguration = () => {
  if (isProd && !process.env.JWT_SECRET) {
    console.log(
      "ℹ️ Note: JWT_SECRET environment variable is not explicitly set; auto-derived from configuration."
    );
  }
  if (isProd && !process.env.SUPER_SECRET_PASSWORD) {
    console.warn(
      "⚠️ Warning: SUPER_SECRET_PASSWORD is not set in Render environment variables. Falling back to default credentials."
    );
  }
};

module.exports = {
  SUPER_SECRET_PASSWORD,
  JWT_SECRET,
  isDevBypassAllowed,
  verifyPassword,
  assertAuthConfiguration,
};
