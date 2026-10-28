const sequelize = require("../database");
const Account = require("./account");
const Transaction = require("./transaction");
const Setting = require("./setting");
const Budget = require("./budget");
const NetWorthSnapshot = require("./netWorthSnapshot");
const AiUsage = require("./aiUsage");
const Rule = require("./rule");
const ImportRef = require("./importRef");

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
  NetWorthSnapshot,
  AiUsage,
  Rule,
  ImportRef,
};
