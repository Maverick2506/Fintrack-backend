const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Paycheque = sequelize.define("Paycheque", {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  payment_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  notes: {
    type: DataTypes.TEXT,
  },
});

module.exports = Paycheque;
