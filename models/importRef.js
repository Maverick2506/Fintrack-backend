const { DataTypes } = require("sequelize");
const sequelize = require("../database");

// The clientRef of a bank row that an import matched to an existing bill (marked it paid) instead of
// creating a row. New imported rows carry their ref in Transactions.clientRef; a matched bill may
// already have its own clientRef (Quick Add), so its import ref is kept here. A re-import of the same
// file finds the ref in either place and skips the row.
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
