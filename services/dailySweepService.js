const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const { getNextDueDate } = require("../routes/recurring");

const TIMEZONE = "America/Toronto";

const runDailySweep = async () => {
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
        bill.amount = amt;
        bill.baseAmount = base;
        bill.taxApplied = true;
      }

      const isPastBill = bill.date < todayString;
      if (
        bill.fromAccount &&
        bill.fromAccount.type === "CREDIT_CARD" &&
        !bill.toAccountId
      ) {
        if (!isPastBill) {
          bill.fromAccount.initialBalance =
            parseFloat(bill.fromAccount.initialBalance || 0) + amt;
          await bill.fromAccount.save({ transaction: dbTx });
        }
      } else if (
        bill.toAccount &&
        (bill.toAccount.type === "DEBT" ||
          bill.toAccount.type === "CREDIT_CARD")
      ) {
        if (!isPastBill) {
          bill.toAccount.initialBalance = Math.max(
            0,
            parseFloat(bill.toAccount.initialBalance || 0) - amt
          );
          await bill.toAccount.save({ transaction: dbTx });
        }
      }
      bill.isCleared = true;
      await bill.save({ transaction: dbTx });
      clearedExpenseCount++;
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

        const paymentAmount = Math.min(remaining, minPay);
        debt.initialBalance = Math.max(0, remaining - paymentAmount);

        const nextDueStr = getNextDueDate(
          debt.dueDate,
          debt.paymentFrequency || "monthly"
        );
        if (nextDueStr && debt.initialBalance > 0) {
          debt.dueDate = nextDueStr;
        } else if (debt.initialBalance <= 0) {
          debt.autoPay = false;
        }

        await debt.save({ transaction: dbTx });

        await Transaction.create(
          {
            title: `Auto-Pay for ${debt.name}`,
            amount: paymentAmount,
            date: todayString,
            type: "EXPENSE",
            category: "Debt",
            isCleared: true,
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
  }
};

module.exports = { runDailySweep };
