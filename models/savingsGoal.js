const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const SavingsGoal = sequelize.define("SavingsGoal", {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  goal_amount: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
  },
  current_amount: {
    type: DataTypes.DECIMAL(12, 2),
    defaultValue: 0.0,
  },
});

module.exports = SavingsGoal;
