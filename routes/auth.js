const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();

const SUPER_SECRET_PASSWORD = process.env.SUPER_SECRET_PASSWORD || "maverick";

const isLocalDevRequest = (req) => {
  if (process.env.NODE_ENV === "production") return false;
  const host = req.hostname || "";
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
};

router.post("/login", async (req, res) => {
  try {
    const { password, devBypass } = req.body;

    const isValidDevBypass = isLocalDevRequest(req) && devBypass === true;

    if (!isValidDevBypass && password !== SUPER_SECRET_PASSWORD) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const token = jwt.sign({ user: "Maverick" }, SUPER_SECRET_PASSWORD, {
      expiresIn: "1d",
    });
    res.json({ token });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Server error during login." });
  }
});

module.exports = router;
