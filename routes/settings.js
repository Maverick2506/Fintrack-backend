const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { Setting } = require("../models");

const router = express.Router();
router.use(authMiddleware);

router.get(
  "/forecast-buffer",
  asyncHandler(async (req, res) => {
    const record = await Setting.findByPk("forecast_buffer");
    const buffer = record && !isNaN(parseFloat(record.value)) ? parseFloat(record.value) : 200;
    res.json({ buffer });
  })
);

router.put(
  "/forecast-buffer",
  validateBody(schemas.setForecastBuffer),
  asyncHandler(async (req, res) => {
    const bufferVal = parseFloat(req.body.buffer);
    await Setting.upsert({
      key: "forecast_buffer",
      value: String(bufferVal),
    });
    res.json({ buffer: bufferVal });
  })
);

module.exports = router;
