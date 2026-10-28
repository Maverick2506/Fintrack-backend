const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const { validateQuery, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { getTodayString } = require("../services/accountBalanceService");
const { buildMonthClose, getCachedCommentary, generateCommentary } = require("../services/monthCloseService");
const { reserveCall, releaseUnanswered, sendCapReached } = require("../services/aiUsageService");
const gemini = require("./gemini");

const router = express.Router();
router.use(authMiddleware);

// The month asked for, or this Toronto month. A month after this one has nothing to close (400).
const resolveMonth = (req, res) => {
  const todayStr = getTodayString();
  const month = req.validatedQuery.month || todayStr.slice(0, 7);
  if (month > todayStr.slice(0, 7)) {
    res.status(400).json({ error: "That month hasn't started yet." });
    return null;
  }
  return { month, todayStr };
};

// GET /api/reports/month-close?month=YYYY-MM: the month's numbers, with commentary only when it was
// already written for these exact numbers (commentary: null otherwise; the next route writes it)
router.get(
  "/month-close",
  validateQuery(schemas.monthCloseQuery),
  asyncHandler(async (req, res) => {
    const resolved = resolveMonth(req, res);
    if (!resolved) return;
    const close = await buildMonthClose(resolved.month, resolved.todayStr);
    res.json({ ...close, commentary: await getCachedCommentary(close) });
  })
);

// GET /api/reports/month-close/commentary?month=YYYY-MM: up to three lines from Gemini about the
// month's numbers (cached per month for the same numbers). 503 without an API key, 429 at the daily cap.
router.get(
  "/month-close/commentary",
  validateQuery(schemas.monthCloseQuery),
  asyncHandler(async (req, res) => {
    const resolved = resolveMonth(req, res);
    if (!resolved) return;
    const close = await buildMonthClose(resolved.month, resolved.todayStr);
    const result = await generateCommentary(close, {
      ai: gemini.getAiClient(),
      generate: gemini.generate,
      reserveCall,
      releaseUnanswered,
      model: gemini.getModels().advice,
      todayStr: resolved.todayStr,
    });
    if (result.unavailable === "no-key") {
      return res.status(503).json({ error: "AI commentary is off (no Gemini API key)." });
    }
    if (result.unavailable === "cap") return sendCapReached(res, result);
    if (result.unavailable) return res.status(502).json({ error: "Couldn't write the commentary. Try again later." });
    res.json({ month: close.month, lines: result.lines, cached: result.cached });
  })
);

module.exports = router;
