const sequelize = require("../database");
const Account = require("./account");
const Transaction = require("./transaction");

Account.hasMany(Transaction, { as: "outgoingTransactions", foreignKey: "fromAccountId", onDelete: "CASCADE" });
Transaction.belongsTo(Account, { as: "fromAccount", foreignKey: "fromAccountId" });

Account.hasMany(Transaction, { as: "incomingTransactions", foreignKey: "toAccountId", onDelete: "CASCADE" });
Transaction.belongsTo(Account, { as: "toAccount", foreignKey: "toAccountId" });

module.exports = {
  sequelize,
  Account,
  Transaction
};
