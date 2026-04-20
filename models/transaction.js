const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Transaction = sequelize.define("Transaction", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
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
    defaultValue: true, // Assume cleared unless pending
  },
  recurrence: {
    type: DataTypes.ENUM("none", "weekly", "bi-weekly", "monthly", "yearly"),
    defaultValue: "none",
  }
});

module.exports = Transaction;
