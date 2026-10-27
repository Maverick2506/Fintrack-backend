const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { retireAccount } = require("../services/accountArchiveService");
const { setBalanceAnchor } = require("../services/balanceAnchorService");
const router = express.Router();
router.param("id", validateIdParam);

router.use("/credit-cards", authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

router.get(
  "/credit-cards",
  asyncHandler(async (req, res) => {
    const cards = await Account.findAll({
      where: { type: "CREDIT_CARD", isActive: { [Op.ne]: false } },
      order: [["createdAt", "ASC"]],
    });
    const formatted = cards.map((c) => ({
      ...c.toJSON(),
      currentBalance: c.initialBalance,
    }));
    res.json(formatted);
  })
);

router.post(
  "/credit-cards",
  validateBody(schemas.createCreditCard),
  asyncHandler(async (req, res) => {
    const { name, creditLimit, currentBalance, initialBalance, dueDate } =
      req.body;

    const newCard = await Account.create({
      name,
      type: "CREDIT_CARD",
      initialBalance: currentBalance ?? initialBalance ?? 0.0,
      creditLimit: parseFloat(creditLimit),
      dueDate: dueDate || null,
      isActive: true,
    });

    res
      .status(201)
      .json({ ...newCard.toJSON(), currentBalance: newCard.initialBalance });
  })
);

router.post(
  "/credit-cards/:id/pay",
  validateBody(schemas.paymentAmount),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const card = await Account.findByPk(req.params.id, { transaction: dbTx });
      const [checking] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });

      if (!card || card.type !== "CREDIT_CARD") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Credit Card not found" });
      }

      const paymentAmount = parseFloat(req.body.amount);
      // Atomic increment avoids lost updates under concurrency
      await Account.increment("initialBalance", {
        by: -paymentAmount,
        where: { id: card.id },
        transaction: dbTx,
      });
      await card.reload({ transaction: dbTx });

      // Record as TRANSFER (not EXPENSE) to prevent double-counting card spending
      await Transaction.create(
        {
          title: `Payment for ${card.name}`,
          amount: paymentAmount,
          date: getTodayString(),
          type: "TRANSFER",
          category: "Credit Card Payment",
          isCleared: true,
          balanceApplied: true,
          fromAccountId: checking.id,
          toAccountId: card.id,
        },
        { transaction: dbTx }
      );

      await dbTx.commit();
      res.json({ ...card.toJSON(), currentBalance: card.initialBalance });
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

// Archives by default. Unpaid rows and recurring series using it are ended or moved to Checking.
router.delete(
  "/credit-cards/:id",
  validateBody(schemas.retireAccount),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const card = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!card || card.type !== "CREDIT_CARD") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Credit Card not found" });
      }

      await retireAccount(card, req.body, dbTx);

      await dbTx.commit();
      res.status(204).send();
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.put(
  "/credit-cards/:id",
  validateBody(schemas.updateCreditCard),
  asyncHandler(async (req, res) => {
    const card = await Account.findByPk(req.params.id);
    if (card && card.type === "CREDIT_CARD") {
      const { name, creditLimit, currentBalance, initialBalance, dueDate } =
        req.body;
      await card.update({
        name: name !== undefined ? name : card.name,
        creditLimit:
          creditLimit !== undefined
            ? parseFloat(creditLimit)
            : card.creditLimit,
        initialBalance:
          currentBalance !== undefined
            ? parseFloat(currentBalance)
            : initialBalance !== undefined
            ? parseFloat(initialBalance)
            : card.initialBalance,
        dueDate: dueDate !== undefined ? dueDate : card.dueDate,
      });
      // A typed balance includes everything up to today; a bank import treats older rows as history
      if (currentBalance !== undefined || initialBalance !== undefined) {
        await setBalanceAnchor(card.id, getTodayString());
      }
      res.json({ ...card.toJSON(), currentBalance: card.initialBalance });
    } else {
      res.status(404).json({ error: "Credit Card not found" });
    }
  })
);

module.exports = router;
