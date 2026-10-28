const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler, HttpError } = require("../middleware/errorHandler");
const { retireAccount } = require("../services/accountArchiveService");
const { setBalanceAnchor } = require("../services/balanceAnchorService");
const crypto = require("crypto");
const { getCardStatement } = require("../services/statementService");
const { getNextOccurrenceDate, getSeriesTemplate } = require("./recurring");
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
    const todayStr = getTodayString();
    const formatted = await Promise.all(
      cards.map(async (c) => ({
        ...c.toJSON(),
        currentBalance: c.initialBalance,
        // { statementDate, dueDate, statementBalance, newCharges, ... } when a statement day is set
        statement: await getCardStatement(c, todayStr),
      }))
    );
    res.json(formatted);
  })
);

router.post(
  "/credit-cards",
  validateBody(schemas.createCreditCard),
  asyncHandler(async (req, res) => {
    const { name, creditLimit, currentBalance, initialBalance, dueDate, statementDay } =
      req.body;

    const newCard = await Account.create({
      name,
      type: "CREDIT_CARD",
      initialBalance: currentBalance ?? initialBalance ?? 0.0,
      creditLimit: parseFloat(creditLimit),
      dueDate: dueDate || null,
      statementDay: statementDay ?? null,
      isActive: true,
    });

    res.status(201).json({
      ...newCard.toJSON(),
      currentBalance: newCard.initialBalance,
      statement: await getCardStatement(newCard, getTodayString()),
    });
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
      const { name, creditLimit, currentBalance, initialBalance, dueDate, statementDay } =
        req.body;
      await card.update({
        statementDay: statementDay !== undefined ? statementDay : card.statementDay,
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
      res.json({
        ...card.toJSON(),
        currentBalance: card.initialBalance,
        statement: await getCardStatement(card, getTodayString()),
      });
    } else {
      res.status(404).json({ error: "Credit Card not found" });
    }
  })
);

// One-tap fix for a scheduled payment above what is owed: sets that payment to the statement balance
// or to the full balance projected for its date (both worked out here). Only that row changes: when it
// is the newest row of a recurring series, the next occurrence is added first at the old amount, so the
// series keeps generating the amount it had.
router.post(
  "/credit-cards/:id/scheduled-payment",
  validateBody(schemas.setScheduledCardPayment),
  asyncHandler(async (req, res) => {
    const todayStr = getTodayString();
    const dbTx = await sequelize.transaction();
    let statement;
    try {
      const card = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!card || card.type !== "CREDIT_CARD" || card.isActive === false) {
        throw new HttpError(404, "Credit Card not found");
      }
      const before = await getCardStatement(card, todayStr, dbTx);
      const scheduled = before?.scheduledPayment;
      if (!scheduled || scheduled.id !== req.body.transactionId) {
        throw new HttpError(409, "That payment is no longer the next one scheduled for this card.");
      }
      const amount = req.body.pay === "statement" ? before.statementBalance : scheduled.projectedBalance;
      if (!(amount > 0)) throw new HttpError(409, "Nothing is owed on this card for that payment.");

      const row = await Transaction.findByPk(scheduled.id, { transaction: dbTx });
      if (row.recurrence && row.recurrence !== "none") {
        const groupId = row.recurringGroupId || crypto.randomUUID();
        if (!row.recurringGroupId) await row.update({ recurringGroupId: groupId }, { transaction: dbTx });
        const seriesRows = await Transaction.findAll({
          where: { recurringGroupId: groupId },
          order: [["date", "DESC"], ["createdAt", "DESC"]],
          transaction: dbTx,
        });
        const series = getSeriesTemplate(seriesRows);
        if (series && series.template.id === row.id) {
          const nextDate = getNextOccurrenceDate(row.date, row.recurrence, 1, series.anchorDay);
          const taken = await Transaction.findOne({
            where: { recurringGroupId: groupId, date: nextDate },
            paranoid: false,
            transaction: dbTx,
          });
          if (nextDate && !taken) {
            await Transaction.create(
              {
                title: row.title,
                amount: row.amount,
                date: nextDate,
                type: row.type,
                category: row.category,
                isCleared: false,
                balanceApplied: false,
                recurrence: row.recurrence,
                recurringGroupId: groupId,
                fromAccountId: row.fromAccountId,
                toAccountId: row.toAccountId,
              },
              { transaction: dbTx }
            );
          }
        }
      }
      await row.update({ amount }, { transaction: dbTx });
      statement = await getCardStatement(card, todayStr, dbTx);
      await dbTx.commit();
    } catch (error) {
      if (!dbTx.finished) await dbTx.rollback();
      throw error;
    }
    res.json({ statement });
  })
);

module.exports = router;
