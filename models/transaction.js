const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Transaction = sequelize.define(
  "Transaction",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    baseAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    isTaxExclusive: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    taxRate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    },
    taxApplied: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM("INCOME", "EXPENSE", "TRANSFER"),
      allowNull: false,
    },
    category: {
      type: DataTypes.STRING,
      defaultValue: "Other",
    },
    isCleared: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    recurrence: {
      type: DataTypes.ENUM("none", "weekly", "bi-weekly", "monthly", "yearly"),
      defaultValue: "none",
    },
    balanceApplied: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    recurringGroupId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    indexes: [
      { fields: ["type", "date"] },
      { fields: ["date"] },
      { fields: ["fromAccountId"] },
      { fields: ["toAccountId"] },
    ],
  }
);

module.exports = Transaction;
