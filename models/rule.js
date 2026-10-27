const { DataTypes } = require("sequelize");
const sequelize = require("../database");

// A categorization rule: a title containing `match` (case-insensitive) gets this category and/or
// account. Rules apply lowest priority number first; the first rule that sets a field wins it.
const Rule = sequelize.define(
  "Rule",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    match: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    category: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    accountId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    priority: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = Rule;
