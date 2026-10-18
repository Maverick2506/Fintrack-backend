const express = require("express");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, verifyPassword, isDevBypassAllowed } = require("../config/auth");
const router = express.Router();

router.post("/login", async (req, res) => {
  try {
    const { password, devBypass } = req.body;

    const isValidDevBypass = isDevBypassAllowed() && devBypass === true;

    if (!isValidDevBypass && !verifyPassword(password)) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const token = jwt.sign({ user: "Maverick" }, JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Server error during login." });
  }
});

module.exports = router;
