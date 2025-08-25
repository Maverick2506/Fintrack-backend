const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Expense = sequelize.define("Expense", {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  due_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  is_paid: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // We've added more useful categories to the ENUM list
  category: {
    type: DataTypes.ENUM(
      "Essentials",
      "Subscription",
      "Debt",
      "Food & Drink",
      "Transportation",
      "Entertainment",
      "Shopping",
      "Other"
    ),
    defaultValue: "Other",
  },
  recurrence: {
    type: DataTypes.ENUM("none", "monthly", "yearly"),
    defaultValue: "none",
  },
});

module.exports = Expense;
