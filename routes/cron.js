const express = require("express");
const cronAuthMiddleware = require("../middleware/cronAuthMiddleware");
const { runDailySweep } = require("../services/dailySweepService");
const { createRecurringExpenses } = require("./recurring");

const router = express.Router();

const handleDailyCheck = async (req, res) => {
  try {
    const result = await runDailySweep();
    res.status(200).json({
      message: "Daily sweep completed successfully.",
      result,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to execute daily sweep." });
  }
};

const handleTriggerRecurring = async (req, res) => {
  try {
    await createRecurringExpenses();
    res.status(200).json({
      message: "Recurring transactions generated successfully.",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to execute recurring transactions generation." });
  }
};

// Support both GET and POST for cron jobs and external webhooks with explicit cron auth
router.all("/daily-check", cronAuthMiddleware, handleDailyCheck);
router.all("/trigger-recurring", cronAuthMiddleware, handleTriggerRecurring);

// Backwards-compatible aliases
router.all("/cron/daily-check", cronAuthMiddleware, handleDailyCheck);
router.all("/cron/trigger-recurring", cronAuthMiddleware, handleTriggerRecurring);

module.exports = router;
