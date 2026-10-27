const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { Setting } = require("../models");
const {
  DEBT_INTEREST_SETTING_KEY,
  isDebtInterestEnabled,
} = require("../services/debtInterestService");
const { getUsage, AI_DAILY_CAP_KEY } = require("../services/aiUsageService");
const { toZonedTime, format } = require("date-fns-tz");
const { getTodayString } = require("../services/accountBalanceService");
const { getPrimaryCheckingAccount } = require("../services/checkingService");
const { normalizePayeeTitle } = require("../utils/payeeNormalizer");
const {
  PAY_TITLE_KEY,
  EXPECTED_PAY_KEY,
  loadPayContext,
} = require("../services/payForecastService");

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

// Pay for the forecast: the detected pay series, the income names to choose it from (pay_title),
// and Expected pay, which the forecast uses only while there's no pay series
const payStatus = async () => {
  const checking = await getPrimaryCheckingAccount();
  const ctx = await loadPayContext({ todayStr: getTodayString(), checkingId: checking ? checking.id : null });
  return {
    paySeries: ctx.pay
      ? {
          title: ctx.pay.title,
          label: ctx.pay.label,
          cadence: ctx.pay.cadence,
          basedOn: ctx.pay.basedOn,
          planningAmount: ctx.pay.planningAmount,
          typicalAmount: ctx.pay.typicalAmount,
          range: ctx.pay.range,
          override: ctx.pay.override,
        }
      : null,
    payTitle: ctx.payTitle,
    incomeNames: ctx.groups.map((g) => ({
      title: g.key,
      label: g.label,
      count: g.count,
      lastDate: g.lastDate,
      cadence: g.cadence,
    })),
    expectedPay: ctx.expectedPay,
    // Expected pay stops counting by itself once a pay series exists
    expectedPayActive: Boolean(ctx.expectedPay && !ctx.pay),
  };
};

router.get(
  "/pay",
  asyncHandler(async (req, res) => {
    res.json(await payStatus());
  })
);

router.put(
  "/expected-pay",
  validateBody(schemas.setExpectedPay),
  asyncHandler(async (req, res) => {
    const { nextDate, cadence, amount } = req.body;
    await Setting.upsert({
      key: EXPECTED_PAY_KEY,
      value: JSON.stringify({ nextDate, cadence, amount: Math.round(amount * 100) / 100 }),
    });
    res.json(await payStatus());
  })
);

router.delete(
  "/expected-pay",
  asyncHandler(async (req, res) => {
    await Setting.destroy({ where: { key: EXPECTED_PAY_KEY } });
    res.json(await payStatus());
  })
);

router.put(
  "/pay-title",
  validateBody(schemas.setPayTitle),
  asyncHandler(async (req, res) => {
    const title = req.body.title === null ? null : normalizePayeeTitle(req.body.title);
    if (title) {
      await Setting.upsert({ key: PAY_TITLE_KEY, value: title });
    } else {
      await Setting.destroy({ where: { key: PAY_TITLE_KEY } });
    }
    res.json(await payStatus());
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

// AI usage today (AI8): calls counted against the ai_daily_cap Setting and the tokens Gemini reported
router.get(
  "/ai-usage",
  asyncHandler(async (req, res) => {
    const todayStr = format(toZonedTime(new Date(), "America/Toronto"), "yyyy-MM-dd", {
      timeZone: "America/Toronto",
    });
    res.json(await getUsage(todayStr));
  })
);

// Daily AI request limit (AI8), 0 to 10,000
router.put(
  "/ai-daily-cap",
  validateBody(schemas.setAiDailyCap),
  asyncHandler(async (req, res) => {
    await Setting.upsert({ key: AI_DAILY_CAP_KEY, value: String(req.body.cap) });
    res.json({ cap: req.body.cap });
  })
);

module.exports = router;
