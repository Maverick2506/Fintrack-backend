const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { Setting } = require("../models");
const {
  DEBT_INTEREST_SETTING_KEY,
  isDebtInterestEnabled,
} = require("../services/debtInterestService");

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

router.get(
  "/forecast-estimate-income",
  asyncHandler(async (req, res) => {
    const record = await Setting.findByPk("forecast_estimate_income");
    const enabled = record ? record.value !== "false" : true;
    res.json({ enabled });
  })
);

router.put(
  "/forecast-estimate-income",
  validateBody(schemas.setForecastEstimateIncome),
  asyncHandler(async (req, res) => {
    const enabled = Boolean(req.body.enabled);
    await Setting.upsert({
      key: "forecast_estimate_income",
      value: String(enabled),
    });
    res.json({ enabled });
  })
);

// Debt interest (R2): the daily sweep records interest on each debt's due date while this is on
router.get(
  "/debt-interest",
  asyncHandler(async (req, res) => {
    res.json({ enabled: await isDebtInterestEnabled(Setting) });
  })
);

router.put(
  "/debt-interest",
  validateBody(schemas.setDebtInterest),
  asyncHandler(async (req, res) => {
    const enabled = Boolean(req.body.enabled);
    await Setting.upsert({ key: DEBT_INTEREST_SETTING_KEY, value: String(enabled) });
    res.json({ enabled });
  })
);

module.exports = router;
