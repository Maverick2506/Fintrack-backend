const express = require("express");
const { sequelize, Account } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const {
  getDeleteImpact,
  recordFinalPayment,
  adjustBalanceToZero,
} = require("../services/accountArchiveService");
const { reconcileAccount } = require("../services/reconcileService");
const router = express.Router();
router.param("id", validateIdParam);

router.use("/accounts", authMiddleware);

// What archiving or deleting a card, debt or savings goal would affect, for the confirm dialog
router.get(
  "/accounts/:id/delete-impact",
  asyncHandler(async (req, res) => {
    const account = await Account.findByPk(req.params.id);
    if (!account || account.type === "CHECKING") {
      return res.status(404).json({ error: "Account not found" });
    }
    res.json(await getDeleteImpact(account));
  })
);

// Settles a card or debt with one payment from Checking, or moves a goal's money back to Checking
const settleRoute = (path, schema, settle) =>
  router.post(
    path,
    validateBody(schema),
    asyncHandler(async (req, res) => {
      const dbTx = await sequelize.transaction();
      try {
        const account = await Account.findByPk(req.params.id, { transaction: dbTx });
        if (!account || account.type === "CHECKING") {
          await dbTx.rollback();
          return res.status(404).json({ error: "Account not found" });
        }
        const trx = await settle(account, req.body, dbTx);
        await dbTx.commit();
        await account.reload();
        res.status(201).json({
          transactionId: trx.id,
          balance: Math.round((parseFloat(account.initialBalance) || 0) * 100) / 100,
        });
      } catch (error) {
        await dbTx.rollback();
        throw error;
      }
    })
  );

settleRoute("/accounts/:id/final-payment", schemas.finalPayment, (account, body, dbTx) =>
  recordFinalPayment(account, dbTx)
);

// Brings the balance to $0 with one Adjustment row (written off, closed by bank, spent)
settleRoute("/accounts/:id/adjust-to-zero", schemas.adjustToZero, (account, body, dbTx) =>
  adjustBalanceToZero(account, body.reason, dbTx)
);

// Sync with statement (F4): one cleared Interest or Adjustment row for the difference
router.post(
  "/accounts/:id/reconcile",
  validateBody(schemas.reconcile),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const account = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!account) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Account not found" });
      }
      const result = await reconcileAccount(account, req.body, dbTx);
      await dbTx.commit();
      res.status(201).json(result);
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

module.exports = router;
