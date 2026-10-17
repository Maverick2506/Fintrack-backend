const { Sequelize } = require("sequelize");

let sequelize;

if (process.env.DATABASE_URL) {
  // Production/Remote Database
  console.log("DATABASE_URL found. Connecting to remote database...");
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: process.env.DB_DIALECT || "postgres",
    logging: process.env.DB_LOGGING === "true" ? console.log : false,
    pool: {
      max: 5,
      min: 0,
      idle: 10000,
      acquire: 30000,
    },
    dialectOptions: {
      keepAlive: true,
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    },
  });
} else {
  // Local Development Fallback
  console.log("No DATABASE_URL found. 🛠️  Falling back to local SQLite database...");
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage: "./local-database.sqlite",
    logging: false,
  });
}

module.exports = sequelize;
