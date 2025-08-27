const sequelize = require("../database");
const Paycheque = require("./paycheque");
const Expense = require("./expense");
const Debt = require("./debt");
const SavingsGoal = require("./savingsGoal");
const CreditCard = require("./creditCard");

// Paycheque to Expense Relationship
Paycheque.hasMany(Expense, {
  foreignKey: "paychequeId",
  onDelete: "SET NULL",
});
Expense.belongsTo(Paycheque, {
  foreignKey: "paychequeId",
});

// Credit Card to Expense Relationship
CreditCard.hasMany(Expense, {
  foreignKey: "creditCardId",
  onDelete: "SET NULL",
});
Expense.belongsTo(CreditCard, {
  foreignKey: "creditCardId",
});

module.exports = {
  sequelize,
  Paycheque,
  Expense,
  Debt,
  SavingsGoal,
  CreditCard,
};
