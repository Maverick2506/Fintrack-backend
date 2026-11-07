const jwt = require("jsonwebtoken");
const { JWT_SECRET, isDevBypassAllowed } = require("../config/auth");
const { isTokenVersionCurrent } = require("../services/tokenVersionService");

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];

  if (token === "dev-local-bypass" && isDevBypassAllowed()) {
    req.user = { user: "Maverick", devBypass: true };
    return next();
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  try {
    if (!(await isTokenVersionCurrent(decoded))) {
      return res.status(401).json({ error: "Signed out. Please log in again." });
    }
  } catch (error) {
    return next(error);
  }
  req.user = decoded;
  next();
};

module.exports = authMiddleware;
