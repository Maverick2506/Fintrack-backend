const express = require("express");
const { Paycheque } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

// Add this route to handle POST requests
router.post("/paycheques", async (req, res) => {
  try {
    const newPaycheque = await Paycheque.create(req.body);
    res.status(201).json(newPaycheque);
  } catch (error) {
    console.error("Error creating paycheque:", error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
