const express = require("express");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const { Transaction, Account, sequelize } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { asyncHandler } = require("../middleware/errorHandler");
const router = express.Router();

const TIMEZONE = "America/Toronto";

router.use(authMiddleware);

const normalizeCadence = (amount, cadence) => {
  const amt = parseFloat(amount) || 0;
  let monthlyCost = 0;
  let annualCost = 0;

  switch (cadence) {
    case "weekly":
      monthlyCost = amt * (52 / 12);
      annualCost = amt * 52;
      break;
    case "bi-weekly":
      monthlyCost = amt * (26 / 12);
      annualCost = amt * 26;
      break;
    case "monthly":
      monthlyCost = amt;
      annualCost = amt * 12;
      break;
    case "yearly":
      monthlyCost = amt / 12;
      annualCost = amt;
      break;
    default:
      monthlyCost = amt;
      annualCost = amt * 12;
  }

  return {
    monthlyCost: Math.round(monthlyCost * 100) / 100,
    annualCost: Math.round(annualCost * 100) / 100,
  };
};

const getComparableAmount = (t) => {
  if (t.isTaxExclusive && t.baseAmount !== null && t.baseAmount !== undefined) {
    return parseFloat(t.baseAmount);
  }
  return parseFloat(t.amount);
};

// GET /api/subscriptions
router.get(
  "/",
  asyncHandler(async (req, res) => {
    // 1. Fetch expense transactions that are part of a recurring series
    const recurringTrxs = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        [Op.or]: [
          { recurrence: { [Op.in]: ["weekly", "bi-weekly", "monthly", "yearly"] } },
          { recurringGroupId: { [Op.ne]: null } },
        ],
      },
      include: [
        { model: Account, as: "fromAccount" },
        { model: Account, as: "toAccount" },
      ],
      order: [
        ["date", "ASC"],
        ["createdAt", "ASC"],
      ],
    });

    // 2. Group by recurringGroupId (or series fallback by title)
    const groups = new Map();
    for (const trx of recurringTrxs) {
      const key = trx.recurringGroupId
        ? `group:${trx.recurringGroupId}`
        : `title:${trx.title.toLowerCase().trim()}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(trx);
    }

    // Use America/Toronto timezone for current date comparison (m3)
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });
    const subscriptions = [];

    for (const [, occurrences] of groups.entries()) {
      // Sort occurrences chronologically
      occurrences.sort((a, b) => a.date.localeCompare(b.date));

      const latestTrx = occurrences[occurrences.length - 1];

      // If the series was explicitly cancelled (recurrence changed to 'none'), exclude from active subscriptions
      if (!latestTrx.recurrence || latestTrx.recurrence === "none") {
        continue;
      }

      const cadence = latestTrx.recurrence;
      // Use taxed total amount for monthly and annual costs (m2)
      const chargedAmount = parseFloat(latestTrx.amount) || 0;
      const { monthlyCost, annualCost } = normalizeCadence(chargedAmount, cadence);

      // Paying account
      let payingAccountName = "Primary Checking";
      let isCreditCard = false;
      let accountId = null;
      if (latestTrx.fromAccount) {
        payingAccountName = latestTrx.fromAccount.name;
        isCreditCard = latestTrx.fromAccount.type === "CREDIT_CARD";
        accountId = latestTrx.fromAccount.id;
      }

      // Next unpaid occurrence (future or today first, or any unpaid)
      const unpaidOccurrences = occurrences.filter((t) => !t.isCleared);
      const nextUnpaid =
        unpaidOccurrences.find((t) => t.date >= todayStr) ||
        unpaidOccurrences[0] ||
        null;

      // Future unpaid occurrences (for cancel confirmation and count)
      const futureUnpaidOccurrences = occurrences.filter(
        (t) => !t.isCleared && t.date > todayStr
      );
      const unpaidUpcomingCount = futureUnpaidOccurrences.length;
      const unpaidUpcomingTotal =
        Math.round(
          futureUnpaidOccurrences.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0) * 100
        ) / 100;

      // Cleared occurrences
      const clearedOccurrences = occurrences.filter((t) => t.isCleared);
      const latestCleared =
        clearedOccurrences.length > 0
          ? clearedOccurrences[clearedOccurrences.length - 1]
          : null;

      // Price change detection:
      // Compare the latest cleared amount with the previous cleared amount in the same series.
      // If baseAmount is specified for tax-exclusive expenses, compare baseAmount.
      let priceChange = null;
      if (clearedOccurrences.length >= 2) {
        const prevCleared = clearedOccurrences[clearedOccurrences.length - 2];
        const prevAmt = getComparableAmount(prevCleared);
        const currAmt = getComparableAmount(latestCleared);
        const diff = Math.round((currAmt - prevAmt) * 100) / 100;
        if (Math.abs(diff) > 0.01) {
          const percent =
            prevAmt > 0 ? Math.round(((currAmt - prevAmt) / prevAmt) * 1000) / 10 : 0;
          priceChange = {
            from: prevAmt,
            to: currAmt,
            difference: diff,
            percent,
            date: latestCleared.date,
          };
        }
      }

      subscriptions.push({
        id: latestTrx.recurringGroupId || latestTrx.id,
        recurringGroupId: latestTrx.recurringGroupId || null,
        latestTransactionId: latestTrx.id,
        nextTransactionId: nextUnpaid ? nextUnpaid.id : latestTrx.id,
        name: latestTrx.title,
        category: latestTrx.category || "Subscriptions",
        cadence,
        latestAmount: chargedAmount,
        baseAmount:
          latestTrx.baseAmount !== null && latestTrx.baseAmount !== undefined
            ? parseFloat(latestTrx.baseAmount)
            : null,
        isTaxExclusive: Boolean(latestTrx.isTaxExclusive),
        taxRate: latestTrx.taxRate ? parseFloat(latestTrx.taxRate) : null,
        monthlyCost,
        annualCost,
        nextDate: nextUnpaid ? nextUnpaid.date : null,
        lastPaidDate: latestCleared ? latestCleared.date : null,
        payingAccount: payingAccountName,
        isCreditCard,
        accountId,
        priceChange,
        unpaidUpcomingCount,
        unpaidUpcomingTotal,
      });
    }

    // Sort by monthly cost descending
    subscriptions.sort((a, b) => b.monthlyCost - a.monthlyCost);

    const totalMonthly =
      Math.round(subscriptions.reduce((sum, s) => sum + s.monthlyCost, 0) * 100) / 100;
    const totalAnnual =
      Math.round(subscriptions.reduce((sum, s) => sum + s.annualCost, 0) * 100) / 100;

    res.json({
      subscriptions,
      totalMonthly,
      totalAnnual,
      count: subscriptions.length,
    });
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

    const dbTx = await sequelize.transaction();
    try {
      // Find all transactions matching recurringGroupId
      let seriesTrxs = await Transaction.findAll({
        where: { recurringGroupId },
        transaction: dbTx,
      });

      // Fallback: if not found by recurringGroupId, check if ID matches a single transaction
      if (seriesTrxs.length === 0) {
        const single = await Transaction.findByPk(recurringGroupId, { transaction: dbTx });
        if (single) {
          if (single.recurringGroupId) {
            seriesTrxs = await Transaction.findAll({
              where: { recurringGroupId: single.recurringGroupId },
              transaction: dbTx,
            });
          } else {
            seriesTrxs = [single];
          }
        }
      }

      if (seriesTrxs.length === 0) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Subscription series not found." });
      }

      // Delete unpaid occurrences dated strictly after today
      const toDelete = seriesTrxs.filter(
        (t) => !t.isCleared && t.date > todayStr
      );
      const toDeleteIds = toDelete.map((t) => t.id);

      if (toDeleteIds.length > 0) {
        // Removed for good, not sent to the Trash: restoring one would restart the subscription
        await Transaction.destroy({
          where: { id: { [Op.in]: toDeleteIds } },
          force: true,
          transaction: dbTx,
        });
      }

      // Update remaining transactions in series to recurrence = "none" (keeping recurringGroupId)
      const remaining = seriesTrxs.filter((t) => !toDeleteIds.includes(t.id));
      const remainingIds = remaining.map((t) => t.id);

      if (remainingIds.length > 0) {
        await Transaction.update(
          { recurrence: "none" },
          {
            where: { id: { [Op.in]: remainingIds } },
            transaction: dbTx,
          }
        );
      }
      // Rows of the series in the Trash stop recurring too, so restoring one does not restart it
      const cancelledGroupId = seriesTrxs.find((t) => t.recurringGroupId)?.recurringGroupId;
      if (cancelledGroupId) {
        await Transaction.update(
          { recurrence: "none" },
          { where: { recurringGroupId: cancelledGroupId }, paranoid: false, transaction: dbTx }
        );
      }

      await dbTx.commit();
      res.json({
        success: true,
        cancelledRows: remainingIds.length,
        deletedRows: toDeleteIds.length,
      });
    } catch (err) {
      await dbTx.rollback();
      throw err;
    }
  })
);

module.exports = router;
