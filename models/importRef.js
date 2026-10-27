const { DataTypes } = require("sequelize");
const sequelize = require("../database");

// Which account's statement each imported bank row came from, and the transaction it became or
// linked to. Its ref is the row's clientRef. A new row also carries the ref in Transactions.clientRef;
// a matched bill keeps its own clientRef (Quick Add), so the ref is only here. A re-import finds the
// ref in either place and skips the row. A card payment links once per account (chequing and card).
const ImportRef = sequelize.define(
  "ImportRef",
  {
    ref: {
      type: DataTypes.UUID,
      primaryKey: true,
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    accountId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = ImportRef;
