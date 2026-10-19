const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const router = express.Router();

router.use(authMiddleware);

const TIMEZONE = "America/Toronto";

const formatYMD = (y, mZeroIndexed, d) => {
  const dateObj = new Date(y, mZeroIndexed, d);
  const yr = dateObj.getFullYear();
  const mo = String(dateObj.getMonth() + 1).padStart(2, "0");
  const da = String(dateObj.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${da}`;
};

const getPrimaryCheckingAccount = async (dbTx = null) => {
  let checking = await Account.findOne({
    where: { type: "CHECKING", isActive: { [Op.ne]: false } },
    order: [["createdAt", "ASC"]],
    transaction: dbTx,
  });
  if (!checking) {
    checking = await Account.findOne({
      where: { name: "Primary Checking" },
      transaction: dbTx,
    });
  }
  if (!checking) {
    checking = await Account.create(
      {
        name: "Primary Checking",
        type: "CHECKING",
        initialBalance: 0.0,
      },
      { transaction: dbTx }
    );
  }
  return checking;
};

router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    const year = req.query.year
      ? parseInt(req.query.year)
      : nowZoned.getFullYear();
    const month = req.query.month
      ? parseInt(req.query.month) - 1
      : nowZoned.getMonth();

    const startOfMonth = formatYMD(year, month, 1);
    const endOfMonth = formatYMD(year, month + 1, 0);

    const startOfPreviousMonth = formatYMD(year, month - 1, 1);
    const endOfPreviousMonth = formatYMD(year, month, 0);

    const isPastMonth = endOfMonth < todayStr;
    const isCurrentMonth =
      year === nowZoned.getFullYear() && month === nowZoned.getMonth();
    const cashFlowEndOfMonth = isCurrentMonth ? todayStr : endOfMonth;
    const upcomingStartDate = isCurrentMonth ? todayStr : startOfMonth;

    // Upcoming bills strictly for the active month (never leaks expenses from future months)
    const upcomingBillsQuery = isPastMonth
      ? Promise.resolve([])
      : Transaction.findAll({
          where: {
            type: "EXPENSE",
            isCleared: false,
            date: { [Op.between]: [upcomingStartDate, endOfMonth] },
          },
          order: [["date", "ASC"]],
          include: [
            { model: Account, as: "fromAccount" },
            { model: Account, as: "toAccount" },
          ],
        });

    const checking = await getPrimaryCheckingAccount();

    // Run all independent dashboard queries in parallel (including spendingByCategory) to eliminate extra HTTP round-trips
    const [
      previousMonthIncome,
      previousMonthSpending,
      totalIncome,
      totalSpending,
      upcomingBills,
      allUpcomingBills,
      debtSummary,
      savingsSummary,
      creditCardSummary,
      spendingByCategoryRaw,
      allTimeIncome,
      allTimeCheckingExp,
      allTimeTransfersOut,
      allTimeTransfersIn,
    ] = await Promise.all([
      Transaction.sum("amount", {
        where: {
          type: "INCOME",
          date: { [Op.between]: [startOfPreviousMonth, endOfPreviousMonth] },
        },
      }),
      Transaction.sum("amount", {
        where: {
          type: "EXPENSE",
          date: { [Op.between]: [startOfPreviousMonth, endOfPreviousMonth] },
        },
      }),
      Transaction.sum("amount", {
        where: {
          type: "INCOME",
          ...(isCurrentMonth ? { isCleared: true } : {}),
          date: { [Op.between]: [startOfMonth, cashFlowEndOfMonth] },
        },
      }),
      Transaction.sum("amount", {
        where: {
          type: "EXPENSE",
          ...(isCurrentMonth ? { isCleared: true } : {}),
          date: { [Op.between]: [startOfMonth, cashFlowEndOfMonth] },
        },
      }),
      upcomingBillsQuery,
      upcomingBillsQuery,
      Account.findAll({
        where: {
          type: "DEBT",
          isActive: { [Op.ne]: false },
          initialBalance: { [Op.gt]: 0 },
        },
        order: [["createdAt", "ASC"]],
      }),
      Account.findAll({
        where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false } },
        order: [["createdAt", "ASC"]],
      }),
      Account.findAll({
        where: { type: "CREDIT_CARD", isActive: { [Op.ne]: false } },
        order: [["createdAt", "ASC"]],
      }),
      Transaction.findAll({
        attributes: [
          "category",
          [sequelize.fn("SUM", sequelize.col("amount")), "total_amount"],
        ],
        where: {
          type: "EXPENSE",
          date: { [Op.between]: [startOfMonth, endOfMonth] },
        },
        group: ["category"],
        raw: true,
      }),
      // Only include cleared income dated on or before today into current checking balance calculation
      Transaction.sum("amount", {
        where: {
          type: "INCOME",
          isCleared: true,
          date: { [Op.lte]: todayStr },
          [Op.or]: [{ toAccountId: checking.id }, { toAccountId: null }],
        },
      }),
      Transaction.sum("amount", {
        where: {
          type: "EXPENSE",
          isCleared: true,
          fromAccountId: checking.id,
        },
      }),
      Transaction.sum("amount", {
        where: { type: "TRANSFER", fromAccountId: checking.id },
      }),
      Transaction.sum("amount", {
        where: { type: "TRANSFER", toAccountId: checking.id },
      }),
    ]);

    const netCheckingActivity =
      (parseFloat(allTimeIncome) || 0) -
      (parseFloat(allTimeCheckingExp) || 0) -
      (parseFloat(allTimeTransfersOut) || 0) +
      (parseFloat(allTimeTransfersIn) || 0);

    const checkingCurrentBalance =
      Math.round(
        ((parseFloat(checking.initialBalance) || 0) + netCheckingActivity) * 100
      ) / 100;

    const spendingSummary = (spendingByCategoryRaw || []).map((item) => ({
      name: item.category,
      value: parseFloat(item.total_amount),
    }));

    res.json({
      monthlySummary: {
        totalIncome: parseFloat(totalIncome) || 0,
        totalSpending: parseFloat(totalSpending) || 0,
        netFlow:
          (parseFloat(totalIncome) || 0) - (parseFloat(totalSpending) || 0),
        previousMonthNetFlow:
          (parseFloat(previousMonthIncome) || 0) -
          (parseFloat(previousMonthSpending) || 0),
      },
      checkingAccount: {
        id: checking.id,
        name: checking.name,
        initialBalance: parseFloat(checking.initialBalance) || 0,
        currentBalance: checkingCurrentBalance,
      },
      upcomingBills,
      allUpcomingBills,
      debtSummary,
      savingsSummary,
      creditCardSummary,
      spendingSummary,
    });
  })
);

router.put(
  "/checking",
  validateBody(schemas.updateChecking),
  asyncHandler(async (req, res) => {
    const checking = await getPrimaryCheckingAccount();

    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    const [
      allTimeIncome,
      allTimeCheckingExp,
      allTimeTransfersOut,
      allTimeTransfersIn,
    ] = await Promise.all([
      Transaction.sum("amount", {
        where: {
          type: "INCOME",
          isCleared: true,
          date: { [Op.lte]: todayStr },
          [Op.or]: [{ toAccountId: checking.id }, { toAccountId: null }],
        },
      }),
      Transaction.sum("amount", {
        where: {
          type: "EXPENSE",
          isCleared: true,
          fromAccountId: checking.id,
        },
      }),
      Transaction.sum("amount", {
        where: { type: "TRANSFER", fromAccountId: checking.id },
      }),
      Transaction.sum("amount", {
        where: { type: "TRANSFER", toAccountId: checking.id },
      }),
    ]);

    const netCheckingActivity =
      (parseFloat(allTimeIncome) || 0) -
      (parseFloat(allTimeCheckingExp) || 0) -
      (parseFloat(allTimeTransfersOut) || 0) +
      (parseFloat(allTimeTransfersIn) || 0);

    const desiredBalance = parseFloat(req.body.balance);
    if (!isNaN(desiredBalance)) {
      const calculatedInitial =
        Math.round((desiredBalance - netCheckingActivity) * 100) / 100;
      checking.initialBalance = calculatedInitial;
      await checking.save({ fields: ["initialBalance", "updatedAt"] });
    }

    const currentBalance =
      Math.round(
        ((parseFloat(checking.initialBalance) || 0) + netCheckingActivity) * 100
      ) / 100;

    res.json({
      id: checking.id,
      name: checking.name,
      initialBalance: parseFloat(checking.initialBalance) || 0,
      currentBalance,
    });
  })
);

router.get(
  "/spending-summary",
  asyncHandler(async (req, res) => {
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const year = req.query.year
      ? parseInt(req.query.year)
      : nowZoned.getFullYear();
    const month = req.query.month
      ? parseInt(req.query.month) - 1
      : nowZoned.getMonth();
    const startOfMonth = formatYMD(year, month, 1);
    const endOfMonth = formatYMD(year, month + 1, 0);

    const spendingByCategory = await Transaction.findAll({
      attributes: [
        "category",
        [sequelize.fn("SUM", sequelize.col("amount")), "total_amount"],
      ],
      where: {
        type: "EXPENSE",
        date: { [Op.between]: [startOfMonth, endOfMonth] },
      },
      group: ["category"],
      raw: true,
    });

    const formattedData = spendingByCategory.map((item) => ({
      name: item.category,
      value: parseFloat(item.total_amount),
    }));
    res.json(formattedData);
  })
);

router.get(
  "/trends",
  asyncHandler(async (req, res) => {
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const baseYear = req.query.year
      ? parseInt(req.query.year)
      : nowZoned.getFullYear();
    const baseMonth = req.query.month
      ? parseInt(req.query.month) - 1
      : nowZoned.getMonth();

    const buckets = [];
    const bucketMap = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(baseYear, baseMonth - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}`;
      const entry = {
        ym,
        name: d.toLocaleString("en-US", { month: "short" }),
        income: 0,
        spending: 0,
      };
      buckets.push(entry);
      bucketMap[ym] = entry;
    }

    const windowStart = formatYMD(baseYear, baseMonth - 5, 1);
    const windowEnd = formatYMD(baseYear, baseMonth + 1, 0);

    const rows = await Transaction.findAll({
      attributes: ["type", "date", "amount"],
      where: {
        type: { [Op.in]: ["INCOME", "EXPENSE"] },
        date: { [Op.between]: [windowStart, windowEnd] },
      },
      raw: true,
    });

    for (const r of rows) {
      const ym = String(r.date).slice(0, 7);
      const bucket = bucketMap[ym];
      if (!bucket) continue;
      const amt = parseFloat(r.amount) || 0;
      if (r.type === "INCOME") bucket.income += amt;
      else if (r.type === "EXPENSE") bucket.spending += amt;
    }

    res.json(
      buckets.map(({ name, income, spending }) => ({
        name,
        income: Number(income.toFixed(2)),
        spending: Number(spending.toFixed(2)),
      }))
    );
  })
);

module.exports = router;
