const { Sequelize } = require("sequelize");

// Database Connection Configuration
const sequelize = new Sequelize("fintrack_db", "root", "Gnome", {
  host: "localhost",
  dialect: "mysql",
});

module.exports = sequelize;
