const rateLimit = require("express-rate-limit");

// Tests always get relaxed limits. RELAX_RATE_LIMIT only works outside
// production, so a stray env var on Render can't open up the login limit.
const isRelaxedEnv = (env = process.env) =>
  env.NODE_ENV === "test" ||
  (env.NODE_ENV !== "production" && env.RELAX_RATE_LIMIT === "true");

const isRelaxed = isRelaxedEnv();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isRelaxed ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isRelaxed ? 500 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI rate limit exceeded. Slow down." },
});

const feedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isRelaxed ? 1000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Feed rate limit exceeded. Try again later." },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isRelaxed ? 2000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

module.exports = { loginLimiter, aiLimiter, feedLimiter, apiLimiter, isRelaxedEnv };
