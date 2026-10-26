const express = require("express");
const { toZonedTime, format } = require("date-fns-tz");
const { sequelize } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { asyncHandler } = require("../middleware/errorHandler");
const { endSeries, resolveSeries } = require("../services/seriesService");
const { getSubscriptionsSummary } = require("../services/subscriptionService");
const router = express.Router();

const TIMEZONE = "America/Toronto";

router.use(authMiddleware);

// GET /api/subscriptions
router.get(
  "/",
  asyncHandler(async (req, res) => {
    // Use America/Toronto timezone for current date comparison (m3)
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
    res.json(await getSubscriptionsSummary(todayStr));
  })
);

// POST /api/subscriptions/:recurringGroupId/cancel (Fix #2)
router.post(
  "/:recurringGroupId/cancel",
  asyncHandler(async (req, res) => {
    const { recurringGroupId } = req.params;
    if (!recurringGroupId) {
      return res.status(400).json({ error: "Missing subscription identifier." });
    }

    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    // Cancelling ends the series through the shared path (services/seriesService.js endSeries)
    const dbTx = await sequelize.transaction();
    try {
      const series = await resolveSeries(recurringGroupId, dbTx);
      if (!series) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Subscription series not found." });
      }
      const ended = await endSeries(series, { todayStr, dbTx });
      await dbTx.commit();
      res.json({
        success: true,
        cancelledRows: ended.keptCount,
        deletedRows: ended.removedUpcomingCount,
        removedUpcomingTotal: ended.removedUpcomingTotal,
      });
    } catch (err) {
      if (!dbTx.finished) await dbTx.rollback();
      throw err;
    }
  })
);

module.exports = router;
