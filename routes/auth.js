const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();

const SUPER_SECRET_PASSWORD = process.env.SUPER_SECRET_PASSWORD;

router.post("/login", async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== SUPER_SECRET_PASSWORD) {
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
