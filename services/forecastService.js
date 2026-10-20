const { Account, Transaction, Setting } = require("../models");
const { Op } = require("sequelize");
const { getTodayString } = require("./accountBalanceService");
const { getBalancesSummary } = require("./netWorthService");
const { getPrimaryCheckingAccount } = require("./checkingService");
const { getNextOccurrenceDate, getNextDueDate } = require("../routes/recurring");

// Pure calendar day addition helper (YYYY-MM-DD + N days)
const addCalendarDays = (baseDateStr, daysToAdd) => {
  const [y, m, d] = baseDateStr.split("-").map(Number);
  const dateUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) + daysToAdd * 24 * 60 * 60 * 1000);
  const yy = dateUtc.getUTCFullYear();
  const mm = String(dateUtc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dateUtc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

/**
 * Computes a day-by-day cashflow forecast for checking account over N days.
 *
 * @param {number} [daysCount=60] Horizon in calendar days
 * @param {import("sequelize").Transaction|null} [dbTx=null]
 * @returns {Promise<{
 *   today: string,
 *   startBalance: number,
 *   buffer: number,
 *   nextPayday: string|null,
 *   safeToSpend: number,
 *   lowestPoint: { date: string, balance: number },
 *   days: Array<{ date: string, balance: number, items: Array<{ title: string, amount: number }> }>
 * }>}
 */
const getForecast = async (daysCount = 60, dbTx = null) => {
  const horizonDays = Math.min(Math.max(parseInt(daysCount, 10) || 60, 1), 365);
  const todayStr = getTodayString();
  const endDateStr = addCalendarDays(todayStr, horizonDays - 1);

  // Initialize day buckets
  const daysMap = {};
  for (let i = 0; i < horizonDays; i++) {
    const dStr = addCalendarDays(todayStr, i);
    daysMap[dStr] = { date: dStr, items: [] };
  }

  // 1. Fetch live checking starting balance, checking account record, and buffer setting
  const [balancesSummary, checkingAcc, bufferSetting] = await Promise.all([
    getBalancesSummary(dbTx, todayStr),
    getPrimaryCheckingAccount(dbTx),
    Setting.findByPk("forecast_buffer", { transaction: dbTx }),
  ]);

  const startBalance = balancesSummary.checking;
  const bufferVal = bufferSetting && !isNaN(parseFloat(bufferSetting.value))
    ? parseFloat(bufferSetting.value)
    : 200;
  const buffer = Math.max(0, bufferVal);
  const checkingId = checkingAcc ? checkingAcc.id : null;

  // 2. Fetch relevant database transactions: overdue uncleared items or items within the horizon
  const dbTransactions = await Transaction.findAll({
    where: {
      [Op.or]: [
        {
          isCleared: false,
          date: { [Op.lt]: todayStr },
        },
        {
          date: { [Op.gte]: todayStr, [Op.lte]: endDateStr },
        },
      ],
    },
    include: [
      { model: Account, as: "fromAccount" },
      { model: Account, as: "toAccount" },
    ],
    order: [["date", "ASC"]],
    transaction: dbTx,
  });

  // Process existing DB transactions
  for (const trx of dbTransactions) {
    const amt = parseFloat(trx.amount) || 0;
    const isPast = trx.date < todayStr;
    const isToday = trx.date === todayStr;

    // Overdue unpaid items: apply on Day 0 (today)
    if (isPast) {
      if (trx.type === "EXPENSE") {
        const fromChecking =
          !trx.fromAccount ||
          trx.fromAccount.type === "CHECKING" ||
          (checkingId && trx.fromAccountId === checkingId);
        if (fromChecking) {
          let effAmt = amt;
          if (trx.isTaxExclusive && trx.taxRate) {
            effAmt = Math.round(effAmt * (1 + parseFloat(trx.taxRate) / 100) * 100) / 100;
          }
          daysMap[todayStr].items.push({
            title: `[Overdue] ${trx.title}`,
            amount: -effAmt,
            type: "expense",
          });
        }
      } else if (trx.type === "TRANSFER") {
        if (checkingId && trx.fromAccountId === checkingId) {
          daysMap[todayStr].items.push({
            title: `[Overdue] ${trx.title}`,
            amount: -amt,
            type: "transfer",
          });
        }
      }
      continue;
    }

    // Cleared expenses or transfers: already deducted from startBalance regardless of date (Fix #4)
    if ((trx.type === "EXPENSE" || trx.type === "TRANSFER") && trx.isCleared) {
      continue;
    }

    // Today items: if already cleared today, they are already baked into startBalance
    if (isToday && trx.isCleared) {
      continue;
    }

    // Future or uncleared items dated between today and endDateStr
    const targetBucket = daysMap[trx.date];
    if (!targetBucket) continue;

    if (trx.type === "INCOME") {
      targetBucket.items.push({
        title: trx.title,
        amount: amt,
        type: "income",
      });
    } else if (trx.type === "EXPENSE") {
      const fromChecking =
        !trx.fromAccount ||
        trx.fromAccount.type === "CHECKING" ||
        (checkingId && trx.fromAccountId === checkingId);
      if (fromChecking) {
        let effAmt = amt;
        if (trx.isTaxExclusive && trx.taxRate) {
          effAmt = Math.round(effAmt * (1 + parseFloat(trx.taxRate) / 100) * 100) / 100;
        }
        targetBucket.items.push({
          title: trx.title,
          amount: -effAmt,
          type: "expense",
        });
      }
      // Note: Credit Card charges (fromAccount.type === "CREDIT_CARD") do NOT reduce checking!
    } else if (trx.type === "TRANSFER") {
      if (checkingId && trx.fromAccountId === checkingId) {
        targetBucket.items.push({
          title: trx.title,
          amount: -amt,
          type: "transfer",
        });
      }
    }
  }

  // 3. Virtual recurring occurrences beyond the 30-day pre-generation horizon
  const recurringTrxs = await Transaction.findAll({
    where: {
      [Op.or]: [
        { recurrence: { [Op.ne]: "none" } },
        { recurringGroupId: { [Op.ne]: null } },
      ],
    },
    include: [
      { model: Account, as: "fromAccount" },
      { model: Account, as: "toAccount" },
    ],
    order: [["date", "DESC"], ["createdAt", "DESC"]],
    transaction: dbTx,
  });

  const latestSeriesMap = {};
  for (const t of recurringTrxs) {
    const key = t.recurringGroupId
      ? `group:${t.recurringGroupId}`
      : `${t.type}:${t.title.toLowerCase().trim()}`;
    if (!latestSeriesMap[key]) {
      latestSeriesMap[key] = t;
    }
  }

  for (const key of Object.keys(latestSeriesMap)) {
    const latest = latestSeriesMap[key];
    if (!latest.recurrence || latest.recurrence === "none") continue;

    let curDate = latest.date;
    while (true) {
      const nextDate = getNextOccurrenceDate(curDate, latest.recurrence, 1);
      if (!nextDate || nextDate > endDateStr) break;
      curDate = nextDate;

      if (nextDate >= todayStr && daysMap[nextDate]) {
        // Skip if this occurrence already exists in database
        const existsInDb = dbTransactions.some((dbt) => {
          if (latest.recurringGroupId && dbt.recurringGroupId === latest.recurringGroupId) {
            return dbt.date === nextDate;
          }
          return (
            dbt.date === nextDate &&
            dbt.type === latest.type &&
            dbt.title.toLowerCase().trim() === latest.title.toLowerCase().trim()
          );
        });
        if (existsInDb) continue;

        const amt = parseFloat(latest.amount) || 0;
        if (latest.type === "INCOME") {
          daysMap[nextDate].items.push({
            title: latest.title,
            amount: amt,
            type: "income",
            virtual: true,
          });
        } else if (latest.type === "EXPENSE") {
          const fromChecking =
            !latest.fromAccount ||
            latest.fromAccount.type === "CHECKING" ||
            (checkingId && latest.fromAccountId === checkingId);
          if (fromChecking) {
            let effAmt = amt;
            if (latest.isTaxExclusive && latest.taxRate) {
              effAmt = Math.round(effAmt * (1 + parseFloat(latest.taxRate) / 100) * 100) / 100;
            }
            daysMap[nextDate].items.push({
              title: latest.title,
              amount: -effAmt,
              type: "expense",
              virtual: true,
            });
          }
        } else if (latest.type === "TRANSFER") {
          if (checkingId && latest.fromAccountId === checkingId) {
            daysMap[nextDate].items.push({
              title: latest.title,
              amount: -amt,
              type: "transfer",
              virtual: true,
            });
          }
        }
      }
    }
  }

  // 4. Auto-Pay Debts
  const autoPayDebts = await Account.findAll({
    where: {
      type: "DEBT",
      autoPay: true,
      isActive: { [Op.ne]: false },
      initialBalance: { [Op.gt]: 0 },
    },
    transaction: dbTx,
  });

  for (const debt of autoPayDebts) {
    let rem = parseFloat(debt.initialBalance) || 0;
    const minPay = parseFloat(debt.minimumPayment) || 0;
    if (rem <= 0 || minPay <= 0 || !debt.dueDate) continue;

    let curDue = debt.dueDate;

    // Overdue auto-pay: due on Day 0 (today)
    if (curDue < todayStr) {
      const alreadyHasTodayPay = dbTransactions.some(
        (t) => t.toAccountId === debt.id && t.date === todayStr
      );
      if (!alreadyHasTodayPay) {
        const payAmt = Math.min(rem, minPay);
        daysMap[todayStr].items.push({
          title: `Auto-Pay for ${debt.name}`,
          amount: -payAmt,
          type: "debt",
        });
        rem = Math.round(Math.max(0, rem - payAmt) * 100) / 100;
      }
      curDue = getNextDueDate(curDue, debt.paymentFrequency || "monthly");
    }

    while (curDue && curDue <= endDateStr && rem > 0) {
      if (curDue >= todayStr && daysMap[curDue]) {
        const alreadyHasPay = dbTransactions.some(
          (t) => t.toAccountId === debt.id && t.date === curDue
        );
        if (!alreadyHasPay) {
          const payAmt = Math.min(rem, minPay);
          daysMap[curDue].items.push({
            title: `Auto-Pay for ${debt.name}`,
            amount: -payAmt,
            type: "debt",
          });
          rem = Math.round(Math.max(0, rem - payAmt) * 100) / 100;
        }
      }
      curDue = getNextDueDate(curDue, debt.paymentFrequency || "monthly");
    }
  }

  // 5. Build timeline, compute running balance, lowest point, and safeToSpend
  const days = [];
  let runningBalance = startBalance;
  let lowestPoint = null;
  let nextPayday = null;

  for (let i = 0; i < horizonDays; i++) {
    const dStr = addCalendarDays(todayStr, i);
    const dayBucket = daysMap[dStr] || { date: dStr, items: [] };

    // Detect next payday: first income occurring strictly after today
    const hasIncome = dayBucket.items.some((it) => it.amount > 0);
    if (hasIncome && !nextPayday && dStr > todayStr) {
      nextPayday = dStr;
    }

    const dayNet = dayBucket.items.reduce((acc, it) => acc + it.amount, 0);
    runningBalance = Math.round((runningBalance + dayNet) * 100) / 100;

    const dayObj = {
      date: dStr,
      balance: runningBalance,
      items: dayBucket.items.map((it) => ({
        title: it.title,
        amount: Math.round(it.amount * 100) / 100,
      })),
    };
    days.push(dayObj);

    if (!lowestPoint || runningBalance < lowestPoint.balance) {
      lowestPoint = { date: dStr, balance: runningBalance };
    }
  }

  // Safe to spend: minimum projected balance between today and day before nextPayday minus buffer
  let minBalanceBeforePayday = runningBalance;
  if (nextPayday) {
    const relevantDays = days.filter((d) => d.date < nextPayday);
    minBalanceBeforePayday = relevantDays.reduce(
      (min, d) => Math.min(min, d.balance),
      Infinity
    );
  } else {
    minBalanceBeforePayday = days.reduce(
      (min, d) => Math.min(min, d.balance),
      Infinity
    );
  }

  const safeToSpend = Math.max(
    0,
    Math.round((minBalanceBeforePayday - buffer) * 100) / 100
  );

  return {
    today: todayStr,
    startBalance: Math.round(startBalance * 100) / 100,
    buffer: Math.round(buffer * 100) / 100,
    nextPayday,
    safeToSpend,
    lowestPoint: lowestPoint || { date: todayStr, balance: Math.round(startBalance * 100) / 100 },
    days,
  };
};

module.exports = {
  getForecast,
  addCalendarDays,
};
