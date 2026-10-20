const rateLimit = require("express-rate-limit");

const isDev = process.env.NODE_ENV !== "production";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI rate limit exceeded. Slow down." },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 2000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

module.exports = { loginLimiter, aiLimiter, apiLimiter };
