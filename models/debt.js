const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Debt = sequelize.define("Debt", {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  total_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  total_remaining: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  monthly_payment: {
    type: DataTypes.DECIMAL(10, 2),
  },
});

module.exports = Debt;
