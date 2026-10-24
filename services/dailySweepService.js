const { sequelize, Account, Transaction, Setting, NetWorthSnapshot } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const { adjustAccountForTransaction } = require("./accountBalanceService");
const {
  DEBT_INTEREST_START_KEY,
  computePeriodInterest,
  getDebtAnchorDay,
  getNextDebtDueDate,
  interestClientRef,
  interestTitle,
  isDebtInterestEnabled,
} = require("./debtInterestService");
const { getBalancesSummary } = require("./netWorthService");

const TIMEZONE = "America/Toronto";
// Arbitrary constant shared by every instance so only one sweep runs at a time across processes
const SWEEP_ADVISORY_LOCK_KEY = 718203941;
let isLocalSweepRunning = false;

// Postgres: transaction-scoped advisory lock, released on commit or rollback.
// SQLite (local/test) serializes writers already, so the in-process flag is enough there.
const tryAcquireSweepLock = async (dbTx) => {
  if (sequelize.getDialect() !== "postgres") return true;
  const [rows] = await sequelize.query(
    "SELECT pg_try_advisory_xact_lock(:key) AS locked",
    { replacements: { key: SWEEP_ADVISORY_LOCK_KEY }, transaction: dbTx }
  );
  return Boolean(rows[0] && rows[0].locked);
};

// First sweep date with interest (see DEBT_INTEREST_START_KEY)
const getInterestStartDate = async (todayStr, dbTx) => {
  const [setting] = await Setting.findOrCreate({
    where: { key: DEBT_INTEREST_START_KEY },
    defaults: { value: todayStr },
    transaction: dbTx,
  });
  return setting.value;
};

// Records one cleared "Interest – <debt>" EXPENSE on the debt for this due date, once (R2).
// Returns the interest charged, or 0 when there is none or it was already recorded.
const recordDebtInterest = async (debt, dueDate, dbTx) => {
  const amount = computePeriodInterest(
    debt.initialBalance,
    debt.interestRate,
    debt.paymentFrequency || "monthly"
  );
  if (amount <= 0) return 0;
  const clientRef = interestClientRef(debt.id, dueDate);
  const existing = await Transaction.findOne({ where: { clientRef }, transaction: dbTx });
  if (existing) return 0;
  const row = await Transaction.create(
    {
      title: interestTitle(debt.name),
      amount,
      date: dueDate,
      type: "EXPENSE",
      category: "Interest",
      isCleared: true,
      balanceApplied: false,
      fromAccountId: debt.id,
      toAccountId: null,
      clientRef,
    },
    { transaction: dbTx }
  );
  // forceApply: a due date the sweep catches up on is past-dated, but the interest is new
  await adjustAccountForTransaction(row, 1, dbTx, true);
  return amount;
};

// options.todayStr overrides "today" (America/Toronto) so tests can use fixed dates.
const runDailySweep = async (options = {}) => {
  if (isLocalSweepRunning) {
    console.log("Daily sweep already executing in-process. Skipping.");
    return { skipped: true, reason: "in_process_lock" };
  }

  isLocalSweepRunning = true;
  console.log("Running Daily Sweep (Credit Cards, Bills, & Auto-Pay Debts)...");
  const dbTx = await sequelize.transaction();
  try {
    if (!(await tryAcquireSweepLock(dbTx))) {
      await dbTx.rollback();
      console.log("Daily sweep already executing in another instance. Skipping.");
      return { skipped: true, reason: "advisory_lock" };
    }

    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    const todayString =
      options.todayStr || format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    let clearedExpenseCount = 0;
    let clearedIncomeCount = 0;
    let autoPayCount = 0;
    let interestCount = 0;

    // 0. Debt interest on each due date, before any payment that day (R2). Debts only, not cards;
    //    archived debts keep their balance. Auto-pay debts move to the next due date in step 3; other
    //    debts move here, so interest comes back every period whether or not auto-pay is on.
    const interestEnabled = await isDebtInterestEnabled(Setting, dbTx);
    const interestStartDate = interestEnabled
      ? await getInterestStartDate(todayString, dbTx)
      : null;
    const dueDebts = await Account.findAll({
      where: {
        type: "DEBT",
        isActive: { [Op.ne]: false },
        dueDate: { [Op.lte]: todayString },
        initialBalance: { [Op.gt]: 0 },
      },
      transaction: dbTx,
    });

    for (const debt of dueDebts) {
      const frequency = debt.paymentFrequency || "monthly";
      const anchorDay = getDebtAnchorDay(debt);
      const paidByAutoPay = Boolean(debt.autoPay) && (parseFloat(debt.minimumPayment) || 0) > 0;
      let dueDate = debt.dueDate;
      let guard = 0;
      while (dueDate && dueDate <= todayString && guard++ < 600) {
        if (interestEnabled && dueDate >= interestStartDate) {
          if ((await recordDebtInterest(debt, dueDate, dbTx)) > 0) {
            interestCount++;
            await debt.reload({ transaction: dbTx });
          }
        }
        // Step 3 pays this due date and moves it on
        if (paidByAutoPay) break;
        dueDate = getNextDebtDueDate(dueDate, frequency, anchorDay);
      }
      if (!paidByAutoPay && dueDate !== debt.dueDate) {
        await Account.update(
          { dueDate },
          { where: { id: debt.id, dueDate: debt.dueDate }, transaction: dbTx }
        );
      }
    }

    // 1. Process Due Pending Expenses & Transfers (Credit Card charges, Paydown bills, & Checking bills)
    const pendingBillsDue = await Transaction.findAll({
      where: {
        isCleared: false,
        type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
        date: { [Op.lte]: todayString },
      },
      include: [
        { model: Account, as: "fromAccount" },
        { model: Account, as: "toAccount" },
      ],
      transaction: dbTx,
    });

    for (const bill of pendingBillsDue) {
      let amt = parseFloat(bill.amount) || 0;
      let baseAmount = bill.baseAmount;
      let taxApplied = Boolean(bill.taxApplied);

      // Apply tax on due date if bill was registered exclusive of tax
      if (
        bill.isTaxExclusive &&
        bill.taxRate &&
        parseFloat(bill.taxRate) > 0 &&
        !bill.taxApplied
      ) {
        const base = parseFloat(bill.baseAmount) || amt;
        const rate = parseFloat(bill.taxRate);
        amt = Math.round(base * (1 + rate / 100) * 100) / 100;
        baseAmount = base;
        taxApplied = true;
      }

      // ATOMIC UPDATE: Only adjust balance if THIS execution flipped isCleared from false to true
      const [affectedRows] = await Transaction.update(
        {
          isCleared: true,
          amount: amt,
          baseAmount,
          taxApplied,
        },
        {
          where: {
            id: bill.id,
            isCleared: false,
          },
          transaction: dbTx,
        }
      );

      // Only adjust account balance if this worker actually won the race and transitioned the bill
      if (affectedRows === 1) {
        bill.isCleared = true;
        bill.amount = amt;
        bill.baseAmount = baseAmount;
        bill.taxApplied = taxApplied;
        await adjustAccountForTransaction(bill, 1, dbTx, true);
        clearedExpenseCount++;
      }
    }

    // 2. Clear Pending Income whose date has arrived
    const [updatedIncomeCount] = await Transaction.update(
      { isCleared: true },
      {
        where: {
          type: "INCOME",
          isCleared: false,
          date: { [Op.lte]: todayString },
        },
        transaction: dbTx,
      }
    );
    clearedIncomeCount = updatedIncomeCount;

    // 3. Process Due Auto-Pay Debts
    const dueAutoPayDebts = await Account.findAll({
      where: {
        type: "DEBT",
        autoPay: true,
        isActive: { [Op.ne]: false },
        dueDate: { [Op.lte]: todayString },
        initialBalance: { [Op.gt]: 0 },
      },
      transaction: dbTx,
    });

    if (dueAutoPayDebts.length > 0) {
      const [checking] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });

      for (const debt of dueAutoPayDebts) {
        const remaining = parseFloat(debt.initialBalance) || 0;
        const minPay = parseFloat(debt.minimumPayment) || 0;
        if (remaining <= 0 || minPay <= 0) continue;

        // Idempotency guard: prevent duplicate auto-pay transaction for the same debt on the same day
        const existingAutoPay = await Transaction.findOne({
          where: {
            toAccountId: debt.id,
            date: todayString,
            title: `Auto-Pay for ${debt.name}`,
          },
          transaction: dbTx,
        });
        if (existingAutoPay) continue;

        const paymentAmount = Math.min(remaining, minPay);
        const newBal =
          Math.round(Math.max(0, remaining - paymentAmount) * 100) / 100;

        const nextDueStr = getNextDebtDueDate(
          debt.dueDate,
          debt.paymentFrequency || "monthly",
          getDebtAnchorDay(debt)
        );

        const updatePayload = {};
        if (nextDueStr && newBal > 0) {
          updatePayload.dueDate = nextDueStr;
        } else {
          updatePayload.autoPay = false;
        }

        // Atomic Compare-And-Swap: Claim this payment by advancing due date or disabling auto-pay
        const [affectedDebtCount] = await Account.update(updatePayload, {
          where: {
            id: debt.id,
            dueDate: debt.dueDate,
            autoPay: true,
          },
          transaction: dbTx,
        });

        if (affectedDebtCount !== 1) {
          // Another concurrent sweep instance already updated this debt
          continue;
        }

        // Atomic decrement avoids lost updates if another balance transaction occurred concurrently
        await Account.increment("initialBalance", {
          by: -paymentAmount,
          where: { id: debt.id },
          transaction: dbTx,
        });

        await debt.reload({ transaction: dbTx });
        if (debt.initialBalance <= 0) {
          await Account.update(
            { autoPay: false },
            { where: { id: debt.id }, transaction: dbTx }
          );
        }

        await Transaction.create(
          {
            title: `Auto-Pay for ${debt.name}`,
            amount: paymentAmount,
            date: todayString,
            type: "TRANSFER",
            category: "Debt",
            isCleared: true,
            balanceApplied: true,
            fromAccountId: checking.id,
            toAccountId: debt.id,
          },
          { transaction: dbTx }
        );
        autoPayCount++;
      }
    }

    // 4. Persist last sweep summary
    await Setting.upsert(
      {
        key: "last_sweep_summary",
        value: JSON.stringify({
          timestamp: new Date().toISOString(),
          clearedExpenses: clearedExpenseCount,
          clearedIncome: clearedIncomeCount,
          autoPayProcessed: autoPayCount,
          interestRecorded: interestCount,
          date: todayString,
        }),
      },
      { transaction: dbTx }
    );

    // 5. Capture or update today's net worth snapshot
    const balances = await getBalancesSummary(dbTx, todayString);
    const existingSnapshot = await NetWorthSnapshot.findOne({
      where: { date: todayString },
      transaction: dbTx,
    });
    if (existingSnapshot) {
      await existingSnapshot.update(
        {
          checking: balances.checking,
          savings: balances.savings,
          debt: balances.debt,
          cards: balances.cards,
          netWorth: balances.netWorth,
        },
        { transaction: dbTx }
      );
    } else {
      await NetWorthSnapshot.create(
        {
          date: todayString,
          checking: balances.checking,
          savings: balances.savings,
          debt: balances.debt,
          cards: balances.cards,
          netWorth: balances.netWorth,
        },
        { transaction: dbTx }
      );
    }

    await dbTx.commit();
    console.log(
      `Daily sweep complete: ${clearedExpenseCount} expenses cleared, ${clearedIncomeCount} incomes cleared, ${autoPayCount} auto-pays processed. Net worth snapshot recorded (${balances.netWorth}).`
    );
    return {
      clearedExpenses: clearedExpenseCount,
      clearedIncome: clearedIncomeCount,
      autoPayProcessed: autoPayCount,
      interestRecorded: interestCount,
      date: todayString,
      netWorth: balances.netWorth,
    };
  } catch (error) {
    await dbTx.rollback();
    console.error("Error running daily sweep:", error);
    throw error;
  } finally {
    isLocalSweepRunning = false;
  }
};

module.exports = { runDailySweep };
