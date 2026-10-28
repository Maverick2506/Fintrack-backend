const { Account, Transaction, Setting } = require("../models");
const { Op } = require("sequelize");
const { getTodayString } = require("./accountBalanceService");
const { getBalancesSummary } = require("./netWorthService");
const { getPrimaryCheckingAccount } = require("./checkingService");
const {
  getNextOccurrenceDate,
  groupSeries,
  getSeriesVacatedDates,
  ACTIVE_RECURRENCES,
} = require("../routes/recurring");
const { usesArchivedAccount } = require("./accountArchiveService");
const {
  DEBT_INTEREST_START_KEY,
  interestClientRef,
  isDebtInterestEnabled,
  projectDebtSchedule,
} = require("./debtInterestService");
const { getCardStatement, getPendingCardCharges } = require("./statementService");
const { getSinkingFunds } = require("./sinkingFundService");
const { loadPayContext, expectedPayDates } = require("./payForecastService");

// Pure calendar day addition helper (YYYY-MM-DD + N days)
const addCalendarDays = (baseDateStr, daysToAdd) => {
  const [y, m, d] = baseDateStr.split("-").map(Number);
  const dateUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) + daysToAdd * 24 * 60 * 60 * 1000);
  const yy = dateUtc.getUTCFullYear();
  const mm = String(dateUtc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dateUtc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const dayDiff = (a, b) => {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / DAY_MS);
};

const hasIncomeNear = (daysMap, dateStr) =>
  Object.values(daysMap).some(
    (d) => Math.abs(dayDiff(d.date, dateStr)) <= 3 && d.items.some((it) => it.amount > 0)
  );

/**
 * Adds "Estimated paycheque" income items on projected paydays when the pay isn't a recurring
 * series (e.g. hourly paycheques logged one at a time). The pay series is found by name
 * (payForecastService.detectPaySeries); other income never changes its cadence or amount.
 * Each projected payday uses the cautious planningAmount. A projected date is skipped when any
 * real or recurring income is within 3 days.
 * Returns { estimate, recurring }: recurring is true when the pay series is already projected.
 */
const estimatePaycheques = async ({ daysMap, todayStr, endDateStr, pay, dbTx }) => {
  if (!pay) return { estimate: null, recurring: false };

  // A recurring series is already projected by step 3, also when its newest paycheque was a One-time edit
  const newest = pay.newestRow;
  if (newest.recurrence && newest.recurrence !== "none") return { estimate: null, recurring: true };
  if (
    newest.recurringGroupId &&
    (await Transaction.count({
      where: {
        recurringGroupId: newest.recurringGroupId,
        recurrence: { [Op.in]: ACTIVE_RECURRENCES },
      },
      transaction: dbTx,
    })) > 0
  ) {
    return { estimate: null, recurring: true };
  }

  const setting = await Setting.findByPk("forecast_estimate_income", { transaction: dbTx });
  if (setting && setting.value === "false") return { estimate: null, recurring: false };
  if (pay.planningAmount <= 0) return { estimate: null, recurring: false };

  const dates = [];
  for (let step = 1; step <= 60; step++) {
    const next = getNextOccurrenceDate(pay.lastDate, pay.cadence, step);
    if (!next || next > endDateStr) break;
    if (next <= todayStr || !daysMap[next] || hasIncomeNear(daysMap, next)) continue;
    daysMap[next].items.push({ title: "Estimated paycheque", amount: pay.planningAmount, type: "income", estimated: true });
    dates.push(next);
  }

  const estimate = dates.length
    ? {
        // amount is the planning amount, the one the forecast uses
        amount: pay.planningAmount,
        planningAmount: pay.planningAmount,
        typicalAmount: pay.typicalAmount,
        range: pay.range,
        cadence: pay.cadence,
        title: pay.label,
        basedOn: pay.basedOn,
        dates,
      }
    : null;
  return { estimate, recurring: false };
};

/**
 * Expected pay (Setting expected_pay): the user's own next pay date, cadence and planning amount,
 * used only while there's no pay series. Adds "Expected pay" items; creates no transactions.
 */
const addExpectedPay = ({ daysMap, todayStr, endDateStr, expectedPay }) => {
  const dates = [];
  for (const date of expectedPayDates(expectedPay, todayStr, endDateStr)) {
    if (!daysMap[date] || hasIncomeNear(daysMap, date)) continue;
    daysMap[date].items.push({ title: "Expected pay", amount: expectedPay.amount, type: "income", estimated: true });
    dates.push(date);
  }
  return dates;
};

// "$1,200" or "$1,150.50", for forecast line titles
const formatMoney = (n) =>
  `$${n.toLocaleString("en-US", Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
 *   days: Array<{ date: string, balance: number, items: Array<{ title: string, amount: number }> }>,
 *   incomeSource: "recurring"|"estimated"|"expected-pay"|"none",
 *   planningAmount: number|null,
 *   typicalAmount: number|null
 * }>}
 */
const getForecast = async (daysCount = 60, dbTx = null, extraItems = [], options = {}) => {
  const horizonDays = Math.min(Math.max(parseInt(daysCount, 10) || 60, 1), 365);
  // options.todayStr overrides "today" (America/Toronto) so tests can use fixed dates
  const todayStr = options.todayStr || getTodayString();
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
    if (usesArchivedAccount(trx)) continue;
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
            seriesId: trx.recurringGroupId,
          });
        }
      } else if (trx.type === "TRANSFER") {
        if (checkingId && trx.fromAccountId === checkingId) {
          daysMap[todayStr].items.push({
            title: `[Overdue] ${trx.title}`,
            amount: -amt,
            type: "transfer",
            toAccountId: trx.toAccountId,
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
          seriesId: trx.recurringGroupId,
        });
      }
      // Note: Credit Card charges (fromAccount.type === "CREDIT_CARD") do NOT reduce checking!
    } else if (trx.type === "TRANSFER") {
      if (checkingId && trx.fromAccountId === checkingId) {
        targetBucket.items.push({
          title: trx.title,
          amount: -amt,
          type: "transfer",
          toAccountId: trx.toAccountId,
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

  // Each series projects from its newest recurring row, after its newest row of any kind (getSeriesTemplate)
  const { seriesTemplates } = groupSeries(recurringTrxs);
  const seriesVacated = await getSeriesVacatedDates(dbTx);

  for (const { template: latest, newestDate, anchorDay } of Object.values(seriesTemplates)) {
    if (usesArchivedAccount(latest)) continue;
    const vacated = seriesVacated.get(latest.recurringGroupId);

    let curDate = latest.date;
    while (true) {
      const nextDate = getNextOccurrenceDate(curDate, latest.recurrence, 1, anchorDay);
      if (!nextDate || nextDate > endDateStr) break;
      curDate = nextDate;

      if (nextDate > newestDate && !vacated?.has(nextDate) && nextDate >= todayStr && daysMap[nextDate]) {
        // Skip if this occurrence already exists in database
        // Matched by series id, as the generator does (a row without one becomes a series under its own id)
        const seriesId = latest.recurringGroupId || latest.id;
        const existsInDb = dbTransactions.some(
          (dbt) => dbt.recurringGroupId === seriesId && dbt.date === nextDate
        );
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
              seriesId: latest.recurringGroupId,
            });
          }
        } else if (latest.type === "TRANSFER") {
          if (checkingId && latest.fromAccountId === checkingId) {
            daysMap[nextDate].items.push({
              title: latest.title,
              amount: -amt,
              type: "transfer",
              virtual: true,
              toAccountId: latest.toAccountId,
            });
          }
        }
      }
    }
  }

  // 3b. Pay: estimated paycheques for a pay series that isn't recurring, or Expected pay while
  //     there's no pay series at all
  const payContext = await loadPayContext({ todayStr, checkingId, dbTx });
  const { estimate: estimatedIncome, recurring: payIsRecurring } = await estimatePaycheques({
    daysMap,
    todayStr,
    endDateStr,
    pay: payContext.pay,
    dbTx,
  });
  const expectedPayUsed = !payContext.pay && payContext.expectedPay
    ? addExpectedPay({ daysMap, todayStr, endDateStr, expectedPay: payContext.expectedPay })
    : [];

  // 3c. Cards with a statement day. Scheduled payments to the card up to the statement's due date (an
  //     overdue statement is due today) keep their amounts, each capped at the card's full balance
  //     projected for its date: paying more than the statement balance pays down new charges, but
  //     nothing beyond what is owed leaves Checking. With nothing scheduled, the statement balance is
  //     paid on the due date. Payments after the due date stay as entered.
  const statementCards = await Account.findAll({
    where: { type: "CREDIT_CARD", isActive: { [Op.ne]: false }, statementDay: { [Op.ne]: null } },
    order: [["createdAt", "ASC"]],
    transaction: dbTx,
  });
  const cardPayments = [];
  for (const card of statementCards) {
    const statement = await getCardStatement(card, todayStr, dbTx);
    if (!statement || !statement.dueDate) continue;
    const payBy = statement.dueDate < todayStr ? todayStr : statement.dueDate;
    const scheduled = [];
    let paidSoFar = 0;
    for (let i = 0; i < horizonDays; i++) {
      const dStr = addCalendarDays(todayStr, i);
      if (dStr > payBy) break;
      const bucket = daysMap[dStr];
      const toCard = bucket.items.filter((it) => it.toAccountId === card.id);
      if (toCard.length === 0) continue;
      const owedThatDay =
        (parseFloat(card.initialBalance) || 0) + (await getPendingCardCharges(card.id, dStr, dbTx));
      for (const it of toCard) {
        const scheduledAmount = Math.round(-it.amount * 100) / 100;
        const paid = Math.round(Math.max(0, Math.min(scheduledAmount, owedThatDay - paidSoFar)) * 100) / 100;
        paidSoFar += paid;
        it.amount = -paid;
        if (paid < scheduledAmount) {
          it.capped = true;
          it.scheduledAmount = scheduledAmount;
        }
        scheduled.push({ date: dStr, scheduledAmount, amount: paid });
      }
      bucket.items = bucket.items.filter((it) => it.toAccountId !== card.id || it.amount !== 0);
    }
    if (scheduled.length === 0 && statement.statementBalance > 0 && daysMap[payBy]) {
      daysMap[payBy].items.push({
        title: `Statement balance – ${card.name}`,
        amount: -statement.statementBalance,
        type: "card",
        toAccountId: card.id,
      });
    }
    cardPayments.push({
      id: card.id,
      name: card.name,
      statementDate: statement.statementDate,
      dueDate: statement.dueDate,
      statementBalance: statement.statementBalance,
      newCharges: statement.newCharges,
      scheduled,
      paymentDate: scheduled.length > 0 ? scheduled[0].date : statement.statementBalance > 0 ? payBy : null,
    });
  }

  // 3d. Sinking funds: a goal saving for a bill sets its monthly amount aside on each contribution date
  //     (sinkingFundService), unless transfers to the goal already do (projected above), or the bill's
  //     charge itself is in the window by the fund's due date. Then nothing is set aside, and the bill
  //     is paid from the fund (the default when it is marked paid): the fund covers
  //     min(bill, its balance + contributions dated before the bill), and only the shortfall leaves
  //     Checking. Those contributions are Checking outflows on their own dates, so each dollar counts once.
  const sinkingFunds = [];
  for (const [goalId, fund] of await getSinkingFunds(todayStr, dbTx)) {
    if (fund.done) continue;
    const billGroupId = fund.linkedBill?.recurringGroupId;
    const billDay =
      billGroupId && fund.dueDate
        ? Object.values(daysMap).find(
            (day) => day.date <= fund.dueDate && day.items.some((it) => it.seriesId === billGroupId)
          )
        : null;
    if (billDay) {
      const billItem = billDay.items.find((it) => it.seriesId === billGroupId);
      const billAmount = Math.round(-billItem.amount * 100) / 100;
      const contributions = Object.values(daysMap)
        .filter((day) => day.date < billDay.date)
        .reduce(
          (sum, day) => sum + day.items.filter((it) => it.toAccountId === goalId).reduce((a, it) => a - it.amount, 0),
          0
        );
      const fundCovers = Math.round(Math.max(0, Math.min(billAmount, fund.saved + contributions)) * 100) / 100;
      if (fundCovers > 0) {
        billItem.amount = -Math.round((billAmount - fundCovers) * 100) / 100;
        billItem.title = `${billItem.title} ${formatMoney(billAmount)} (fund covers ${formatMoney(fundCovers)})`;
        billItem.fundCovers = fundCovers;
        billItem.billAmount = billAmount;
      }
      sinkingFunds.push({
        id: goalId, name: fund.name, monthly: fund.monthly, dueDate: fund.dueDate, plannedDates: [],
        billInWindow: true, billDate: billDay.date, billAmount, fundCovers,
      });
      continue;
    }
    if (fund.monthlyTransfer || !fund.monthly) continue;
    const plannedDates = fund.dates.filter((d) => daysMap[d]);
    for (const d of plannedDates) {
      daysMap[d].items.push({
        title: `Set aside for ${fund.name}`,
        amount: -fund.monthly,
        type: "planned",
        planned: true,
      });
    }
    sinkingFunds.push({ id: goalId, name: fund.name, monthly: fund.monthly, dueDate: fund.dueDate, plannedDates, billInWindow: false });
  }

  // 4. Debts: interest on each due date, then auto-pay, projected exactly as the daily sweep runs them
  //    (debtInterestService.projectDebtSchedule). Only auto-pay leaves Checking; interest changes how
  //    much is owed, and so the size of the last payment. Non-auto-pay debts are projected for `debts`.
  const [interestEnabled, interestStartSetting, activeDebts] = await Promise.all([
    isDebtInterestEnabled(Setting, dbTx),
    Setting.findByPk(DEBT_INTEREST_START_KEY, { transaction: dbTx }),
    Account.findAll({
      where: {
        type: "DEBT",
        isActive: { [Op.ne]: false },
        initialBalance: { [Op.gt]: 0 },
        dueDate: { [Op.ne]: null },
      },
      order: [["createdAt", "ASC"]],
      transaction: dbTx,
    }),
  ]);
  // Before the first sweep with interest has run, it will start from its own run date (today or later)
  const interestStartDate = interestStartSetting ? interestStartSetting.value : todayStr;
  const debtProjections = [];

  for (const debt of activeDebts) {
    const minPay = parseFloat(debt.minimumPayment) || 0;
    const autoPay = Boolean(debt.autoPay) && minPay > 0;
    const schedule = projectDebtSchedule({
      balance: debt.initialBalance,
      apr: debt.interestRate,
      minimumPayment: minPay,
      autoPay,
      dueDate: debt.dueDate,
      dueDay: debt.dueDay,
      frequency: debt.paymentFrequency || "monthly",
      fromDate: debt.dueDate,
      toDate: endDateStr,
      interestEnabled,
      interestStartDate,
      // Rows the sweep already recorded for a due date. An overdue due date is paid today.
      handledFor: (dueDate) => {
        const payDate = dueDate < todayStr ? todayStr : dueDate;
        return {
          interest: dbTransactions.some((t) => t.clientRef === interestClientRef(debt.id, dueDate)),
          payment: dbTransactions.some((t) => t.toAccountId === debt.id && t.date === payDate),
        };
      },
    });

    for (const step of schedule) {
      if (step.payment > 0) {
        const payDate = step.date < todayStr ? todayStr : step.date;
        if (daysMap[payDate]) {
          daysMap[payDate].items.push({
            title: `Auto-Pay for ${debt.name}`,
            amount: -step.payment,
            type: "debt",
          });
        }
      }
    }
    debtProjections.push({ id: debt.id, name: debt.name, schedule });
  }

  // 4b. Inject hypothetical simulated items (e.g. for simulatePurchase S1)
  if (Array.isArray(extraItems) && extraItems.length > 0) {
    for (const item of extraItems) {
      const d = item.date || todayStr;
      if (daysMap[d]) {
        daysMap[d].items.push({
          title: item.title || "Simulated Item",
          amount: parseFloat(item.amount) || 0,
          simulated: true,
        });
      }
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
        ...(it.estimated ? { estimated: true } : {}),
        ...(it.planned ? { planned: true } : {}),
        ...(it.type === "card" ? { statement: true } : {}),
        ...(it.capped ? { capped: true, scheduledAmount: it.scheduledAmount } : {}),
        ...(it.fundCovers ? { fundCovers: it.fundCovers, billAmount: it.billAmount } : {}),
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

  // Where the forecast's income comes from, and the paycheque it plans with
  const paydayIncome = nextPayday
    ? Math.round(
        days.find((d) => d.date === nextPayday).items.reduce((sum, it) => sum + (it.amount > 0 ? it.amount : 0), 0) * 100
      ) / 100
    : null;
  let incomeSource = "none";
  let planningAmount = null;
  let typicalAmount = null;
  let payRange = null;
  if (estimatedIncome) {
    incomeSource = "estimated";
    planningAmount = estimatedIncome.planningAmount;
    typicalAmount = estimatedIncome.typicalAmount;
    payRange = estimatedIncome.range;
  } else if (expectedPayUsed.length) {
    incomeSource = "expected-pay";
    planningAmount = typicalAmount = payContext.expectedPay.amount;
  } else if (days.some((d) => d.items.some((it) => it.amount > 0 && !it.simulated))) {
    // Recurring paycheques or income already entered for a future date
    incomeSource = "recurring";
    planningAmount = typicalAmount = paydayIncome;
  }

  return {
    today: todayStr,
    startBalance: Math.round(startBalance * 100) / 100,
    buffer: Math.round(buffer * 100) / 100,
    nextPayday,
    safeToSpend,
    lowestPoint: lowestPoint || { date: todayStr, balance: Math.round(startBalance * 100) / 100 },
    days,
    estimatedIncome,
    incomeSource,
    planningAmount,
    typicalAmount,
    payRange,
    paySeries: payContext.pay
      ? {
          title: payContext.pay.title,
          label: payContext.pay.label,
          cadence: payContext.pay.cadence,
          basedOn: payContext.pay.basedOn,
          override: payContext.pay.override,
          recurring: payIsRecurring,
        }
      : null,
    expectedPayActive: incomeSource === "expected-pay",
    // A pay_title that doesn't form a valid series is ignored for now (automatic detection runs instead)
    payOverrideIgnored: payContext.overrideIgnored,
    debts: debtProjections,
    cardPayments,
    sinkingFunds,
  };
};

module.exports = {
  getForecast,
  addCalendarDays,
};
