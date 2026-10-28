const express = require("express");
const { sequelize } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { getTodayString } = require("../services/accountBalanceService");
const { createRecurringExpenses } = require("./recurring");
const {
  findSubscriptionSuggestions,
  acceptSubscriptionSuggestion,
  dismissSubscriptionSuggestion,
} = require("../services/alertService");

const router = express.Router();
router.param("id", validateIdParam);
router.use(authMiddleware);

const NOT_FOUND = { error: "That suggestion is no longer available." };

// GET /api/alerts/subscription-suggestions: "Make this a subscription?" cards for the dashboard
router.get(
  "/subscription-suggestions",
  asyncHandler(async (req, res) => {
    const suggestions = await findSubscriptionSuggestions(getTodayString());
    res.json({ suggestions: suggestions.map(({ rowIds, ...s }) => s) });
  })
);

// Accept: the newest charge becomes a monthly series; upcoming rows are generated after the commit
router.post(
  "/subscription-suggestions/:id/accept",
  validateBody(schemas.noFields),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    let result;
    try {
      result = await acceptSubscriptionSuggestion(req.params.id, getTodayString(), dbTx);
      if (!result) {
        await dbTx.rollback();
        return res.status(404).json(NOT_FOUND);
      }
      await dbTx.commit();
    } catch (err) {
      if (!dbTx.finished) await dbTx.rollback();
      throw err;
    }
    try {
      await createRecurringExpenses();
    } catch (err) {
      console.error("Recurring generation after accepting a suggestion failed:", err);
    }
    res.status(201).json(result);
  })
);

router.post(
  "/subscription-suggestions/:id/dismiss",
  validateBody(schemas.noFields),
  asyncHandler(async (req, res) => {
    const dismissed = await dismissSubscriptionSuggestion(req.params.id, getTodayString());
    if (!dismissed) return res.status(404).json(NOT_FOUND);
    res.status(204).send();
  })
);

module.exports = router;
