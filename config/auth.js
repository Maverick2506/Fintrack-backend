const crypto = require("crypto");

const isProd = () => process.env.NODE_ENV === "production";

const DEV_DEFAULT_PASSWORD = "maverick";
const MIN_JWT_SECRET_LENGTH = 32;
const SCRYPT_KEYLEN = 64;

// Outside production, the password falls back to a local default so the app runs with no setup.
// Production must provide SUPER_SECRET_PASSWORD_HASH (preferred) or SUPER_SECRET_PASSWORD.
const SUPER_SECRET_PASSWORD =
  process.env.SUPER_SECRET_PASSWORD || (isProd() ? null : DEV_DEFAULT_PASSWORD);

// Production must set JWT_SECRET explicitly (assertAuthConfiguration refuses to boot otherwise).
// Outside production, a signing key is derived from the dev password so local tokens survive restarts.
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (isProd()
    ? null
    : crypto
        .createHmac("sha256", "fintrack-jwt-signing-salt-v1")
        .update(SUPER_SECRET_PASSWORD || DEV_DEFAULT_PASSWORD)
        .digest("hex"));

const isDevBypassAllowed = () => {
  if (isProd()) return false;
  return process.env.ALLOW_DEV_BYPASS === "true";
};

// Hash format: scrypt$<salt hex>$<derived key hex> (generate with `node scripts/hash-password.js`)
const hashPassword = (password, salt = crypto.randomBytes(16)) => {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
};

const parsePasswordHash = (stored) => {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  const salt = Buffer.from(parts[1], "hex");
  const key = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || key.length !== SCRYPT_KEYLEN) return null;
  return { salt, key };
};

const verifyPassword = (inputPassword) => {
  if (typeof inputPassword !== "string" || inputPassword.length === 0) {
    return false;
  }

  const storedHash = process.env.SUPER_SECRET_PASSWORD_HASH;
  if (storedHash) {
    const parsed = parsePasswordHash(storedHash);
    if (!parsed) return false;
    const derived = crypto.scryptSync(inputPassword, parsed.salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(derived, parsed.key);
  }

  const activePassword =
    process.env.SUPER_SECRET_PASSWORD || (isProd() ? null : DEV_DEFAULT_PASSWORD);
  if (!activePassword) {
    return false;
  }
  const inputHash = crypto.createHash("sha256").update(inputPassword).digest();
  const targetHash = crypto
    .createHash("sha256")
    .update(activePassword)
    .digest();
  return crypto.timingSafeEqual(inputHash, targetHash);
};

const assertAuthConfiguration = () => {
  if (!isProd()) return;

  const storedHash = process.env.SUPER_SECRET_PASSWORD_HASH;
  if (storedHash) {
    if (!parsePasswordHash(storedHash)) {
      throw new Error(
        "❌ FATAL CONFIGURATION ERROR: SUPER_SECRET_PASSWORD_HASH is malformed. Generate it with `node scripts/hash-password.js`."
      );
    }
  } else if (
    !process.env.SUPER_SECRET_PASSWORD ||
    process.env.SUPER_SECRET_PASSWORD === DEV_DEFAULT_PASSWORD
  ) {
    throw new Error(
      "❌ FATAL CONFIGURATION ERROR: SUPER_SECRET_PASSWORD is not set or is set to default credentials ('maverick') in production environment variables. Refusing to boot with default credentials."
    );
  } else {
    console.warn(
      "⚠️ SUPER_SECRET_PASSWORD is stored in plaintext. Set SUPER_SECRET_PASSWORD_HASH (see scripts/hash-password.js) and remove it."
    );
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `❌ FATAL CONFIGURATION ERROR: JWT_SECRET must be set to a random value of at least ${MIN_JWT_SECRET_LENGTH} characters in production. Refusing to derive it from the password.`
    );
  }
};

module.exports = {
  SUPER_SECRET_PASSWORD,
  JWT_SECRET,
  isDevBypassAllowed,
  hashPassword,
  verifyPassword,
  assertAuthConfiguration,
};
