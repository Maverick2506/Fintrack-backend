const express = require("express");
const { Op } = require("sequelize");
const { Transaction, Account } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { asyncHandler } = require("../middleware/errorHandler");
const router = express.Router();

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

router.get(
  "/subscriptions",
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

    const todayStr = new Date().toISOString().slice(0, 10);
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
      const latestAmount = getComparableAmount(latestTrx);
      const { monthlyCost, annualCost } = normalizeCadence(latestAmount, cadence);

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

      // Cleared occurrences
      const clearedOccurrences = occurrences.filter((t) => t.isCleared);
      const latestCleared =
        clearedOccurrences.length > 0
          ? clearedOccurrences[clearedOccurrences.length - 1]
          : null;

      // Price change detection:
      // Compare the latest cleared amount with the previous cleared amount in the same series.
      // If they differ by > $0.01 -> priceChange: { from, to, date, percent, difference }
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
        latestAmount,
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

module.exports = router;
