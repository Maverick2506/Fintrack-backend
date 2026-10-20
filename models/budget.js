const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Budget = sequelize.define(
  "Budget",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    category: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    monthlyLimit: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    rollover: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = Budget;
