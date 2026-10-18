const crypto = require("crypto");

const isProd = process.env.NODE_ENV === "production";

const SUPER_SECRET_PASSWORD =
  process.env.SUPER_SECRET_PASSWORD ||
  (isProd ? null : "maverick");

const JWT_SECRET =
  process.env.JWT_SECRET ||
  (isProd ? null : "fintrack-dev-jwt-secret-do-not-use-in-production");

const isDevBypassAllowed = () => {
  if (isProd) return false;
  return process.env.ALLOW_DEV_BYPASS === "true" || !process.env.NODE_ENV || process.env.NODE_ENV === "development";
};

const verifyPassword = (inputPassword) => {
  if (!SUPER_SECRET_PASSWORD || typeof inputPassword !== "string") {
    return false;
  }
  const inputHash = crypto.createHash("sha256").update(inputPassword).digest();
  const targetHash = crypto.createHash("sha256").update(SUPER_SECRET_PASSWORD).digest();
  return crypto.timingSafeEqual(inputHash, targetHash);
};

const assertAuthConfiguration = () => {
  if (isProd) {
    const missing = [];
    if (!process.env.SUPER_SECRET_PASSWORD) missing.push("SUPER_SECRET_PASSWORD");
    if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
    if (missing.length > 0) {
      throw new Error(
        `FATAL SECURITY CONFIGURATION: Missing required environment variable(s) in production: ${missing.join(", ")}`
      );
    }
  }
};

module.exports = {
  SUPER_SECRET_PASSWORD,
  JWT_SECRET,
  isDevBypassAllowed,
  verifyPassword,
  assertAuthConfiguration,
};
