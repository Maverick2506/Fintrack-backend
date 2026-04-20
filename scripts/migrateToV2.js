const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  const match = envContent.match(/DATABASE_URL=(.*)/);
  if (match && match[1]) {
    process.env.DATABASE_URL = match[1].trim();
    console.log("🔒 Loaded DATABASE_URL from .env");
  }
}

const {
  sequelize,
  Paycheque,
  Expense,
  Debt,
  SavingsGoal,
  CreditCard,
  Account,
  Transaction,
} = require("../models");

async function migrate() {
  console.log("🚀 Starting V2 Migration...");
  try {
    // 1. Sync DB and clear V2 tables to prevent duplicates
    await sequelize.sync({ alter: true });
    await require("../models").Transaction.destroy({ where: {} });
    await require("../models").Account.destroy({ where: {} });
    console.log("✅ Tables synced and old V2 data cleared.");

    // 2. Create the Primary Checking Account
    let checking = await Account.findOne({ where: { name: "Primary Checking" } });
    if (!checking) {
      checking = await Account.create({
        name: "Primary Checking",
        type: "CHECKING",
        initialBalance: 0.0,
      });
      console.log("✅ Created Primary Checking account.");
    }

    // 3. Migrate Credit Cards
    const oldCards = await CreditCard.findAll();
    const cardMap = {};
    for (const card of oldCards) {
      const acc = await Account.create({
        name: card.name,
        type: "CREDIT_CARD",
        initialBalance: card.currentBalance || 0,
        creditLimit: card.creditLimit || null,
        dueDate: card.dueDate || null,
      });
      cardMap[card.id] = acc.id;
    }
    console.log(`✅ Migrated ${oldCards.length} Credit Cards.`);

    // 4. Migrate Debts
    const oldDebts = await Debt.findAll();
    const debtMap = {};
    for (const debt of oldDebts) {
      const acc = await Account.create({
        name: debt.name,
        type: "DEBT",
        initialBalance: debt.total_remaining || 0,
        targetAmount: debt.total_amount || null,
        minimumPayment: debt.monthly_payment || null,
        interestRate: debt.interest_rate || null,
      });
      debtMap[debt.id] = acc.id;
    }
    console.log(`✅ Migrated ${oldDebts.length} Debts.`);

    // 5. Migrate Savings Goals
    const oldGoals = await SavingsGoal.findAll();
    const goalMap = {};
    for (const goal of oldGoals) {
      const acc = await Account.create({
        name: goal.name,
        type: "SAVINGS_GOAL",
        initialBalance: goal.current_amount || 0,
        targetAmount: goal.goal_amount || null,
        dueDate: goal.target_date || null,
      });
      goalMap[goal.id] = acc.id;
    }
    console.log(`✅ Migrated ${oldGoals.length} Savings Goals.`);

    // 6. Migrate Paycheques (Income)
    const incomes = await Paycheque.findAll();
    for (const inc of incomes) {
      await Transaction.create({
        title: inc.name,
        amount: inc.amount,
        date: inc.payment_date,
        type: "INCOME",
        category: "Income",
        isCleared: true,
        recurrence: inc.recurrence || "none",
        toAccountId: checking.id, // Money arrives in checking
      });
    }
    console.log(`✅ Migrated ${incomes.length} Income records.`);

    // 7. Migrate Expenses
    const expenses = await Expense.findAll();
    let transferCount = 0;
    let standardCount = 0;

    for (const exp of expenses) {
      // Is it a Credit Card Payment?
      if (exp.category === "Debt" && exp.name.startsWith("Payment for")) {
        // Attempt to find which card it was
        // Usually we don't have a rigid relationship back to the card for the payment itself, 
        // but we'll categorize it as a TRANSFER out of checking.
        await Transaction.create({
          title: exp.name,
          amount: exp.amount,
          date: exp.due_date,
          type: "TRANSFER",
          category: "Credit Card Payment",
          isCleared: exp.is_paid,
          fromAccountId: checking.id,
          // If we could map it cleanly to cardMap, we'd put toAccountId: cardMap[id]
        });
        transferCount++;
        continue;
      }

      // Is it a purchase made ON a credit card?
      if (exp.paid_with_credit_card && exp.creditCardId && cardMap[exp.creditCardId]) {
        await Transaction.create({
          title: exp.name,
          amount: exp.amount,
          date: exp.due_date,
          type: "EXPENSE",
          category: exp.category,
          isCleared: exp.is_paid,
          recurrence: exp.recurrence || "none",
          fromAccountId: cardMap[exp.creditCardId], // Spent from Credit Card
        });
        standardCount++;
        continue;
      }

      // Standard Checking Expense
      await Transaction.create({
        title: exp.name,
        amount: exp.amount,
        date: exp.due_date,
        type: "EXPENSE",
        category: exp.category,
        isCleared: exp.is_paid,
        recurrence: exp.recurrence || "none",
        fromAccountId: checking.id,
      });
      standardCount++;
    }
    
    console.log(`✅ Migrated ${standardCount} Expenses and ${transferCount} Transfers.`);
    console.log("🎉 MIGRATION COMPLETE! V2 is ready.");

  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    process.exit(0);
  }
}

migrate();
