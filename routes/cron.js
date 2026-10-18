const express = require("express");
const cronAuthMiddleware = require("../middleware/cronAuthMiddleware");
const { runDailySweep } = require("../services/dailySweepService");
const { createRecurringExpenses } = require("./recurring");

const router = express.Router();

router.use(cronAuthMiddleware);

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

// Support both GET (for Vercel Cron and webhooks) and POST (for manual/programmatic triggers)
router.get("/daily-check", handleDailyCheck);
router.post("/daily-check", handleDailyCheck);

router.get("/cron/daily-check", handleDailyCheck);
router.post("/cron/daily-check", handleDailyCheck);

router.get("/recurring/trigger-recurring", handleTriggerRecurring);
router.post("/recurring/trigger-recurring", handleTriggerRecurring);

router.get("/cron/trigger-recurring", handleTriggerRecurring);
router.post("/cron/trigger-recurring", handleTriggerRecurring);

module.exports = router;
