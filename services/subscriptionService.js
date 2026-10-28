const { Op } = require("sequelize");
const { Transaction, Account } = require("../models");
const { ACTIVE_RECURRENCES } = require("../routes/recurring");

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

/**
 * Active recurring expense series (subscriptions and bills) with monthly and yearly cost, next
 * unpaid date and price changes. Shared by GET /api/subscriptions, Ask FinTrack's getSubscriptions and
 * the nightly price-change alert (alertService).
 * todayStr is Toronto today.
 */
const getSubscriptionsSummary = async (todayStr, dbTx = null) => {
  // 1. Fetch expense transactions that are part of a recurring series
  const recurringTrxs = await Transaction.findAll({
    where: {
      type: "EXPENSE",
      [Op.or]: [
        { recurrence: { [Op.in]: ACTIVE_RECURRENCES } },
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
    transaction: dbTx,
  });

  // 2. Group by recurringGroupId; a row without one is on its own (see getSeriesKey)
  const groups = new Map();
  for (const trx of recurringTrxs) {
    const key = trx.recurringGroupId ? `group:${trx.recurringGroupId}` : `row:${trx.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(trx);
  }

  const subscriptions = [];

  for (const [, occurrences] of groups.entries()) {
    // Sort occurrences chronologically
    occurrences.sort((a, b) => a.date.localeCompare(b.date));

    // The newest row that still recurs: a One-time edit to a later row changes only that row. A
    // cancelled or ended series has no recurring row left and is not listed.
    const latestTrx = [...occurrences]
      .reverse()
      .find((t) => ACTIVE_RECURRENCES.includes(t.recurrence));
    if (!latestTrx) {
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
          rowId: latestCleared.id,
          // The three paid amounts before this one agree within ±2% of the one just before it: a
          // steady price that changed, not a bill that varies (only those raise a price alert)
          steadyBefore:
            clearedOccurrences.length >= 4 &&
            clearedOccurrences
              .slice(-4, -1)
              .every((t) => prevAmt > 0 && Math.abs(getComparableAmount(t) - prevAmt) <= prevAmt * 0.02),
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

  return {
    subscriptions,
    totalMonthly,
    totalAnnual,
    count: subscriptions.length,
  };
};

module.exports = { getSubscriptionsSummary, normalizeCadence };
