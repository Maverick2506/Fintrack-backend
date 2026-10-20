const sequelize = require("../database");
const Account = require("./account");
const Transaction = require("./transaction");
const Setting = require("./setting");
const Budget = require("./budget");

Account.hasMany(Transaction, {
  as: "outgoingTransactions",
  foreignKey: "fromAccountId",
  onDelete: "SET NULL",
});
Transaction.belongsTo(Account, {
  as: "fromAccount",
  foreignKey: "fromAccountId",
});

Account.hasMany(Transaction, {
  as: "incomingTransactions",
  foreignKey: "toAccountId",
  onDelete: "SET NULL",
});
Transaction.belongsTo(Account, {
  as: "toAccount",
  foreignKey: "toAccountId",
});

module.exports = {
  sequelize,
  Account,
  Transaction,
  Setting,
  Budget,
};
