const { Sequelize } = require("sequelize");

// This new configuration uses a single DATABASE_URL environment variable.
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "mysql",
  dialectOptions: {
    // Railway's MySQL databases require an SSL connection.
    ssl: {
      require: true,
      rejectUnauthorized: false, // This is often needed to connect without certificate issues.
    },
  },
});

module.exports = sequelize;
