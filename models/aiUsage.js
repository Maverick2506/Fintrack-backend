const { DataTypes } = require("sequelize");
const sequelize = require("../database");

// One row per Toronto day: AI calls made and the tokens Gemini reported for them (AI8)
const AiUsage = sequelize.define(
  "AiUsage",
  {
    date: {
      type: DataTypes.DATEONLY,
      primaryKey: true,
    },
    calls: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    promptTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    outputTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    totalTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = AiUsage;
