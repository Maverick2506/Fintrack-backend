const jwt = require("jsonwebtoken");
const { JWT_SECRET, isDevBypassAllowed } = require("../config/auth");

const cronAuthMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  // 1. Authenticate with CRON_SECRET (standard for Vercel Cron and automated webhooks)
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    req.isCron = true;
    return next();
  }

  // 2. Authenticate with standard user JWT if an Authorization header is provided
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token === "dev-local-bypass" && isDevBypassAllowed()) {
      req.user = { user: "Maverick", devBypass: true };
      return next();
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  // 3. In local dev without Authorization header, allow triggering if CRON_SECRET is not configured
  if (!authHeader && !cronSecret && isDevBypassAllowed()) {
    req.isCron = true;
    return next();
  }

  return res.status(401).json({
    error:
      "Unauthorized: missing or invalid cron authorization token (Bearer CRON_SECRET or user JWT required).",
  });
};

module.exports = cronAuthMiddleware;
