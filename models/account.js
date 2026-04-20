const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Account = sequelize.define("Account", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM("CHECKING", "CREDIT_CARD", "SAVINGS_GOAL", "DEBT"),
    allowNull: false,
  },
  initialBalance: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0.0,
  },
  creditLimit: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  targetAmount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  interestRate: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true,
  },
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  minimumPayment: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  }
});

module.exports = Account;
