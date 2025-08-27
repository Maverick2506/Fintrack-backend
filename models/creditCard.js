const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const CreditCard = sequelize.define("CreditCard", {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Use a more descriptive name: creditLimit
  creditLimit: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  // Use a more descriptive name: currentBalance
  currentBalance: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0.0,
  },
  // Add the dueDate field
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
});

module.exports = CreditCard;
