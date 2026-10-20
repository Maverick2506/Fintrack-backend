const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const { getNextDueDate } = require("../routes/recurring");

const TIMEZONE = "America/Toronto";
let isLocalSweepRunning = false;

const runDailySweep = async () => {
  if (isLocalSweepRunning) {
    console.log("Daily sweep already executing in-process. Skipping.");
    return { skipped: true, reason: "in_process_lock" };
  }

  isLocalSweepRunning = true;
  console.log("Running Daily Sweep (Credit Cards, Bills, & Auto-Pay Debts)...");
  const dbTx = await sequelize.transaction();
  try {
    const nowUtc = new Date();
    const nowZoned = toZonedTime(nowUtc, TIMEZONE);
    const todayString = format(nowZoned, "yyyy-MM-dd", { timeZone: TIMEZONE });

    let clearedExpenseCount = 0;
    let clearedIncomeCount = 0;
    let autoPayCount = 0;

    // 1. Process Due Pending Expenses (Credit Card charges, Paydown bills, & Checking bills)
    const pendingBillsDue = await Transaction.findAll({
      where: {
        isCleared: false,
        type: "EXPENSE",
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
          balanceApplied: true,
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
        if (
          bill.fromAccount &&
          bill.fromAccount.type === "CREDIT_CARD" &&
          !bill.toAccountId
        ) {
          await Account.increment("initialBalance", {
            by: amt,
            where: { id: bill.fromAccountId },
            transaction: dbTx,
          });
        } else if (
          bill.toAccount &&
          (bill.toAccount.type === "DEBT" ||
            bill.toAccount.type === "CREDIT_CARD")
        ) {
          await Account.increment("initialBalance", {
            by: -amt,
            where: { id: bill.toAccountId },
            transaction: dbTx,
          });
        }
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

        const nextDueStr = getNextDueDate(
          debt.dueDate,
          debt.paymentFrequency || "monthly"
        );

        const updatePayload = {
          initialBalance: newBal,
        };
        if (nextDueStr && newBal > 0) {
          updatePayload.dueDate = nextDueStr;
        } else if (newBal <= 0) {
          updatePayload.autoPay = false;
        }

        // Atomic Compare-And-Swap: Only adjust account and create payment if this instance successfully claimed the due payment
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

        await Transaction.create(
          {
            title: `Auto-Pay for ${debt.name}`,
            amount: paymentAmount,
            date: todayString,
            type: "EXPENSE",
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

    await dbTx.commit();
    console.log(
      `Daily sweep complete: ${clearedExpenseCount} expenses cleared, ${clearedIncomeCount} incomes cleared, ${autoPayCount} auto-pays processed.`
    );
    return {
      clearedExpenses: clearedExpenseCount,
      clearedIncome: clearedIncomeCount,
      autoPayProcessed: autoPayCount,
      date: todayString,
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
