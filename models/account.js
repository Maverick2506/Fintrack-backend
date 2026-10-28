const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Account = sequelize.define(
  "Account",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
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
    // Debts: day of month the payment is meant to fall on, so a 31st due date returns to the 31st
    // after a short month (R3). Set from dueDate when the user sets it; the sweep never changes it.
    dueDay: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Credit cards: day of month the statement closes (1-31; a short month closes on its last day).
    // Splits the balance into the statement balance and new charges since.
    statementDay: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Savings goals: the bill (recurringGroupId of an expense series) this goal saves up for
    linkedRecurringGroupId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    minimumPayment: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    autoPay: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    paymentFrequency: {
      type: DataTypes.STRING,
      defaultValue: "monthly",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    registeredType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    contributionRoom: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    roomYear: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    indexes: [{ fields: ["type"] }],
  }
);

module.exports = Account;
