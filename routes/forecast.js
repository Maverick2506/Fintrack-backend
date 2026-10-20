const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const { asyncHandler } = require("../middleware/errorHandler");
const { getForecast } = require("../services/forecastService");

const router = express.Router();
router.use(authMiddleware);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const days = req.query.days ? parseInt(req.query.days, 10) : 60;
    const forecast = await getForecast(days);
    res.json(forecast);
  })
);

module.exports = router;
