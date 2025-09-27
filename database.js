const { Sequelize } = require("sequelize");

// The DATABASE_URL environment variable will be in the format:
// mysql://user:password@host:port/database
// or
// postgres://user:password@host:port/database
console.log(
  "DATABASE_URL variable from environment:",
  process.env.DATABASE_URL
);

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: process.env.DB_DIALECT || "postgres",
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
});

module.exports = sequelize;
