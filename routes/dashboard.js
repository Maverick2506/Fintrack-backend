const express = require("express");
const {
  sequelize,
  Account,
  Transaction,
} = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const authMiddleware = require("../middleware/authMiddleware");
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

router.get("/dashboard", async (req, res) => {
  try {
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const todayStr = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    const year = req.query.year ? parseInt(req.query.year) : nowZoned.getFullYear();
    const month = req.query.month ? parseInt(req.query.month) - 1 : nowZoned.getMonth();

    const startOfMonth = formatYMD(year, month, 1);
    const endOfMonth = formatYMD(year, month + 1, 0);

    const startOfPreviousMonth = formatYMD(year, month - 1, 1);
    const endOfPreviousMonth = formatYMD(year, month, 0);

    const previousMonthIncome = await Transaction.sum("amount", {
      where: { type: "INCOME", date: { [Op.between]: [startOfPreviousMonth, endOfPreviousMonth] } }
    });

    const previousMonthSpending = await Transaction.sum("amount", {
      where: { type: "EXPENSE", date: { [Op.between]: [startOfPreviousMonth, endOfPreviousMonth] } }
    });

    const isCurrentMonth = year === nowZoned.getFullYear() && month === nowZoned.getMonth();
    const cashFlowEndOfMonth = isCurrentMonth ? todayStr : endOfMonth;

    const totalIncome = await Transaction.sum("amount", {
      where: { type: "INCOME", date: { [Op.between]: [startOfMonth, cashFlowEndOfMonth] } }
    });

    const totalSpending = await Transaction.sum("amount", {
      where: { type: "EXPENSE", date: { [Op.between]: [startOfMonth, cashFlowEndOfMonth] } }
    });

    const upcomingBills = await Transaction.findAll({
      where: { type: "EXPENSE", isCleared: false, date: { [Op.gte]: todayStr } },
      order: [["date", "ASC"]],
      limit: 5,
    });

    const allUpcomingBills = await Transaction.findAll({
      where: {
        type: "EXPENSE", isCleared: false,
        date: { [Op.between]: [todayStr, endOfMonth] },
      },
      order: [["date", "ASC"]],
    });

    const debtSummary = await Account.findAll({ where: { type: "DEBT" } });
    const savingsSummary = await Account.findAll({ where: { type: "SAVINGS_GOAL" } });
    const creditCardSummary = await Account.findAll({
      where: { type: "CREDIT_CARD" },
      include: [{ model: Transaction, as: "outgoingTransactions" }], 
    });

    const [checking] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
    });

    const [allTimeIncome, allTimeCheckingExp, allTimeTransfersOut, allTimeTransfersIn] = await Promise.all([
      Transaction.sum("amount", { where: { type: "INCOME" } }),
      Transaction.sum("amount", { where: { type: "EXPENSE", isCleared: true, fromAccountId: checking.id } }),
      Transaction.sum("amount", { where: { type: "TRANSFER", fromAccountId: checking.id } }),
      Transaction.sum("amount", { where: { type: "TRANSFER", toAccountId: checking.id } }),
    ]);

    const netCheckingActivity =
      (parseFloat(allTimeIncome) || 0) -
      (parseFloat(allTimeCheckingExp) || 0) -
      (parseFloat(allTimeTransfersOut) || 0) +
      (parseFloat(allTimeTransfersIn) || 0);

    const checkingCurrentBalance = (parseFloat(checking.initialBalance) || 0) + netCheckingActivity;

    res.json({
      monthlySummary: {
        totalIncome: parseFloat(totalIncome) || 0,
        totalSpending: parseFloat(totalSpending) || 0,
        netFlow: (parseFloat(totalIncome) || 0) - (parseFloat(totalSpending) || 0),
        previousMonthNetFlow: (parseFloat(previousMonthIncome) || 0) - (parseFloat(previousMonthSpending) || 0),
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
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/checking", async (req, res) => {
  try {
    const [checking] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
    });

    const [allTimeIncome, allTimeCheckingExp, allTimeTransfersOut, allTimeTransfersIn] = await Promise.all([
      Transaction.sum("amount", { where: { type: "INCOME" } }),
      Transaction.sum("amount", { where: { type: "EXPENSE", isCleared: true, fromAccountId: checking.id } }),
      Transaction.sum("amount", { where: { type: "TRANSFER", fromAccountId: checking.id } }),
      Transaction.sum("amount", { where: { type: "TRANSFER", toAccountId: checking.id } }),
    ]);

    const netCheckingActivity =
      (parseFloat(allTimeIncome) || 0) -
      (parseFloat(allTimeCheckingExp) || 0) -
      (parseFloat(allTimeTransfersOut) || 0) +
      (parseFloat(allTimeTransfersIn) || 0);

    const desiredBalance = parseFloat(req.body.balance);
    if (!isNaN(desiredBalance)) {
      checking.initialBalance = desiredBalance - netCheckingActivity;
      await checking.save();
    }

    res.json({
      id: checking.id,
      name: checking.name,
      initialBalance: parseFloat(checking.initialBalance) || 0,
      currentBalance: (parseFloat(checking.initialBalance) || 0) + netCheckingActivity,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get("/spending-summary", async (req, res) => {
  try {
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const year = req.query.year ? parseInt(req.query.year) : nowZoned.getFullYear();
    const month = req.query.month ? parseInt(req.query.month) - 1 : nowZoned.getMonth();
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
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch spending summary." });
  }
});

router.get("/trends", async (req, res) => {
  try {
    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const baseYear = req.query.year ? parseInt(req.query.year) : nowZoned.getFullYear();
    const baseMonth = req.query.month ? parseInt(req.query.month) - 1 : nowZoned.getMonth();
    const trends = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(baseYear, baseMonth - i, 1);
      const startOfMonth = formatYMD(d.getFullYear(), d.getMonth(), 1);
      const endOfMonth = formatYMD(d.getFullYear(), d.getMonth() + 1, 0);

      const income = await Transaction.sum("amount", {
        where: { type: "INCOME", date: { [Op.between]: [startOfMonth, endOfMonth] } },
      });

      const spending = await Transaction.sum("amount", {
        where: { type: "EXPENSE", date: { [Op.between]: [startOfMonth, endOfMonth] } },
      });

      trends.push({
        name: d.toLocaleString("default", { month: "short" }),
        income: parseFloat(income) || 0,
        spending: parseFloat(spending) || 0,
      });
    }
    res.json(trends);
  } catch (error) {
    console.error("Error fetching trends:", error);
    res.status(500).json({ error: "Failed to fetch trends data." });
  }
});

module.exports = router;
