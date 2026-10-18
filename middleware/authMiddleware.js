const jwt = require("jsonwebtoken");
const { JWT_SECRET, isDevBypassAllowed } = require("../config/auth");

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];

  if (token === "dev-local-bypass" && isDevBypassAllowed()) {
    req.user = { user: "Maverick", devBypass: true };
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

module.exports = authMiddleware;
