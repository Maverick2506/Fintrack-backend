const crypto = require("crypto");
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
    clientRef: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    // Set when a delete took this row's balance off its card, debt or goal; restore puts it back
    balanceReversedOnDelete: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Rows a bank CSV import created; they show in the "Review new" inbox until confirmed
    needsReview: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    // Deleted rows stay in the Trash (deletedAt set) until the nightly sweep purges them after 30 days.
    // Every query leaves them out unless it passes paranoid: false.
    paranoid: true,
    indexes: [
      { fields: ["type", "date"] },
      { fields: ["date"] },
      { fields: ["fromAccountId"] },
      { fields: ["toAccountId"] },
    ],
  }
);

// A recurring row always belongs to a series: a row saved as recurring without a recurringGroupId gets
// a new one, whichever route created or edited it (the generator groups by id only; see getSeriesKey).
// Static bulk writes skip this hook; none of them set a recurrence on a row without an id.
const SAVED_RECURRENCES = ["weekly", "bi-weekly", "monthly", "yearly"];
Transaction.addHook("beforeSave", (trx) => {
  if (SAVED_RECURRENCES.includes(trx.recurrence) && !trx.recurringGroupId) {
    trx.recurringGroupId = crypto.randomUUID();
  }
});

module.exports = Transaction;
