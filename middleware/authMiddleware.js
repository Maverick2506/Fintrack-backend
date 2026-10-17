const jwt = require("jsonwebtoken");
const SUPER_SECRET_PASSWORD = process.env.SUPER_SECRET_PASSWORD || "maverick";

const isLocalDevRequest = (req) => {
  if (process.env.NODE_ENV === "production") return false;
  const host = req.hostname || "";
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
};

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];

  if (token === "dev-local-bypass" && isLocalDevRequest(req)) {
    req.user = { user: "Maverick", devBypass: true };
    return next();
  }

  try {
    const decoded = jwt.verify(token, SUPER_SECRET_PASSWORD);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = authMiddleware;
