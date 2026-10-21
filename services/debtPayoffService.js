/**
 * Debt payoff simulation engine (CommonJS).
 * Ported from Phase H frontend debtMath for Gemini Function Calling & backend intelligence.
 */

function normalizeMonthlyPayment(payment, frequency = "monthly") {
  const p = parseFloat(payment) || 0;
  const freq = (frequency || "monthly").toLowerCase();
  if (freq === "weekly") return (p * 52) / 12;
  if (freq === "bi-weekly" || freq === "biweekly") return (p * 26) / 12;
  if (freq === "yearly" || freq === "annually") return p / 12;
  return p;
}

function getMonthlyRate(apr) {
  const rate = parseFloat(apr) || 0;
  return rate / 100 / 12;
}

function checkSolvency(balance, monthlyPayment, apr) {
  const b = parseFloat(balance) || 0;
  const p = parseFloat(monthlyPayment) || 0;
  const r = getMonthlyRate(apr);
  if (b <= 0) return { solvent: true, monthlyInterest: 0 };
  const monthlyInterest = b * r;
  if (r > 0 && p <= monthlyInterest) {
    return {
      solvent: false,
      monthlyInterest: Math.round(monthlyInterest * 100) / 100,
    };
  }
  return {
    solvent: true,
    monthlyInterest: Math.round(monthlyInterest * 100) / 100,
  };
}

function addCalendarMonths(baseDate, months) {
  const d = new Date(baseDate.getTime());
  const curDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const maxDays = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(curDay, maxDays));
  return d;
}

function formatDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function simulate(
  rawDebts = [],
  extraPerMonth = 0,
  strategy = "avalanche",
  baseDate = new Date()
) {
  const extra = Math.max(0, parseFloat(extraPerMonth) || 0);

  const debts = rawDebts
    .map((d) => {
      const balance =
        Math.round(
          (parseFloat(d.total_remaining ?? d.initialBalance ?? 0) || 0) * 100
        ) / 100;
      const originalBalance = balance;
      const minPayment = normalizeMonthlyPayment(
        d.monthly_payment ?? d.minimumPayment ?? 0,
        d.payment_frequency ?? d.paymentFrequency
      );
      const apr = parseFloat(d.interest_rate ?? d.interestRate ?? 0) || 0;
      const hasApr =
        d.interest_rate !== null &&
        d.interest_rate !== undefined &&
        d.interest_rate !== "" &&
        d.interestRate !== null &&
        d.interestRate !== undefined &&
        d.interestRate !== "";

      const solvency = checkSolvency(balance, minPayment, apr);

      return {
        id: d.id,
        name: d.name || "Debt",
        balance,
        originalBalance,
        minPayment,
        apr,
        hasApr,
        isSolvent: solvency.solvent,
        solvencyInterest: solvency.monthlyInterest,
        payoffMonth: balance <= 0 ? 0 : null,
        payoffDate: balance <= 0 ? formatDateStr(baseDate) : null,
        totalInterest: 0,
      };
    })
    .filter((d) => d.originalBalance > 0);

  if (debts.length === 0) {
    return {
      debtFreeMonth: 0,
      debtFreeDate: formatDateStr(baseDate),
      totalInterest: 0,
      perDebt: [],
      hasInsolventDebt: false,
    };
  }

  const insolventDebts = debts.filter((d) => !d.isSolvent);
  const hasInsolventDebt = insolventDebts.length > 0;

  let totalInterest = 0;
  const MAX_MONTHS = 600;
  let currentMonth = 0;

  while (currentMonth < MAX_MONTHS) {
    const activeDebts = debts.filter((d) => d.balance > 0);
    if (activeDebts.length === 0) break;

    currentMonth++;
    const monthDate = addCalendarMonths(baseDate, currentMonth);

    // 1. Accrue interest
    for (const debt of activeDebts) {
      const r = getMonthlyRate(debt.apr);
      const interest = Math.round(debt.balance * r * 100) / 100;
      debt.balance = Math.round((debt.balance + interest) * 100) / 100;
      debt.totalInterest = Math.round((debt.totalInterest + interest) * 100) / 100;
      totalInterest = Math.round((totalInterest + interest) * 100) / 100;
    }

    // 2. Minimums
    let rolloverBudget = extra;
    for (const debt of activeDebts) {
      const payment = Math.min(debt.balance, debt.minPayment);
      debt.balance = Math.round((debt.balance - payment) * 100) / 100;
      const freed = debt.minPayment - payment;
      if (freed > 0) rolloverBudget += freed;
    }

    const paidOffDebts = debts.filter(
      (d) => d.payoffMonth !== null && d.payoffMonth < currentMonth
    );
    for (const p of paidOffDebts) {
      rolloverBudget += p.minPayment;
    }

    // 3. Extra payment allocation
    const stillActive = debts.filter((d) => d.balance > 0);
    if (stillActive.length > 0 && rolloverBudget > 0) {
      stillActive.sort((a, b) => {
        if (strategy === "snowball") {
          if (a.balance !== b.balance) return a.balance - b.balance;
          return b.apr - a.apr;
        }
        if (b.apr !== a.apr) return b.apr - a.apr;
        return a.balance - b.balance;
      });

      for (const target of stillActive) {
        if (rolloverBudget <= 0) break;
        const extraPayment = Math.min(target.balance, rolloverBudget);
        target.balance = Math.round((target.balance - extraPayment) * 100) / 100;
        rolloverBudget = Math.round((rolloverBudget - extraPayment) * 100) / 100;
      }
    }

    // 4. Record payoff
    for (const debt of activeDebts) {
      if (debt.balance <= 0.005 && debt.payoffMonth === null) {
        debt.balance = 0;
        debt.payoffMonth = currentMonth;
        debt.payoffDate = formatDateStr(monthDate);
      }
    }

    const currentTotalBalance = debts.reduce(
      (sum, d) => sum + Math.max(0, d.balance),
      0
    );
    if (currentTotalBalance <= 0) break;
  }

  const allDebtsPaid = debts.every((d) => d.balance <= 0.005);
  const debtFreeMonth = allDebtsPaid ? currentMonth : null;
  const debtFreeDate = debtFreeMonth
    ? formatDateStr(addCalendarMonths(baseDate, debtFreeMonth))
    : null;

  return {
    debtFreeMonth,
    debtFreeDate,
    totalInterest: Math.round(totalInterest * 100) / 100,
    perDebt: debts.map((d) => ({
      id: d.id,
      name: d.name,
      originalBalance: d.originalBalance,
      apr: d.apr,
      minPayment: d.minPayment,
      payoffMonth: d.payoffMonth,
      payoffDate: d.payoffDate,
      totalInterest: Math.round(d.totalInterest * 100) / 100,
      isSolvent: d.isSolvent,
    })),
    hasInsolventDebt,
    insolventDebts: insolventDebts.map((d) => d.name),
  };
}

function comparePlans(debts = [], extraPerMonth = 0, strategy = "avalanche") {
  const baseline = simulate(debts, 0, "avalanche");
  const planned = simulate(debts, extraPerMonth, strategy);

  const interestSaved =
    baseline.totalInterest !== null && planned.totalInterest !== null
      ? Math.max(
          0,
          Math.round((baseline.totalInterest - planned.totalInterest) * 100) / 100
        )
      : 0;

  const monthsSaved =
    baseline.debtFreeMonth !== null && planned.debtFreeMonth !== null
      ? Math.max(0, baseline.debtFreeMonth - planned.debtFreeMonth)
      : 0;

  return {
    baseline,
    planned,
    interestSaved,
    monthsSaved,
  };
}

module.exports = {
  normalizeMonthlyPayment,
  getMonthlyRate,
  checkSolvency,
  simulate,
  comparePlans,
};
