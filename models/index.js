const sequelize = require("../database");
const Paycheque = require("./paycheque");
const Expense = require("./expense");
const Debt = require("./debt");
const SavingsGoal = require("./savingsGoal");

// Define the relationship: One-to-Many
// A Paycheque can have many Expenses.
// This will add a `paychequeId` column to the Expenses table.
Paycheque.hasMany(Expense, {
  foreignKey: "paychequeId",
  onDelete: "SET NULL", // If a paycheque is deleted, the expense's link is set to null
});
Expense.belongsTo(Paycheque, {
  foreignKey: "paychequeId",
});

// We can add other relationships here in the future if needed

module.exports = {
  sequelize,
  Paycheque,
  Expense,
  Debt,
  SavingsGoal,
};
