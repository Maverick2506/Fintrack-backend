const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const Setting = sequelize.define(
  "Setting",
  {
    key: {
      type: DataTypes.STRING,
      primaryKey: true,
    },
    value: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = Setting;
