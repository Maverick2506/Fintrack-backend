const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const CreditCard = sequelize.define("CreditCard", {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  limit: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  balance: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0.0,
  },
});

module.exports = CreditCard;
