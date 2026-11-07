const express = require("express");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, verifyPassword, isDevBypassAllowed } = require("../config/auth");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { getTokenVersion, bumpTokenVersion } = require("../services/tokenVersionService");
const router = express.Router();

router.post("/login", async (req, res) => {
  try {
    const { password, devBypass } = req.body;

    const isValidDevBypass = isDevBypassAllowed() && devBypass === true;

    if (!isValidDevBypass && !verifyPassword(password)) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // tv = token_version at sign-in; "Sign out all devices" bumps it so older tokens stop working
    const tv = await getTokenVersion();
    const token = jwt.sign({ user: "Maverick", tv }, JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Server error during login." });
  }
});

// Sign out everywhere, this device included. Feed and widget keys are not touched.
router.post("/sign-out-all", authMiddleware, validateBody(schemas.noFields), async (req, res, next) => {
  try {
    const tokenVersion = await bumpTokenVersion();
    res.json({ signedOut: true, tokenVersion });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
