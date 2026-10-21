const rateLimit = require("express-rate-limit");

const isRelaxed =
  process.env.NODE_ENV === "test" ||
  process.env.RELAX_RATE_LIMIT === "true";

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

module.exports = { loginLimiter, aiLimiter, feedLimiter, apiLimiter };
