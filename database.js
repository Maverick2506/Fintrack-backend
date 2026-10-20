const path = require("path");
const { Sequelize } = require("sequelize");

let sequelize;

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

const shouldUseRemoteDb =
  !isTest &&
  Boolean(process.env.DATABASE_URL) &&
  (isProduction || process.env.USE_PRODUCTION_DB === "true");

if (shouldUseRemoteDb) {
  // Production / Remote Database (Render / Vercel)
  console.log("Connecting to remote production database...");
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
        rejectUnauthorized:
          process.env.DB_SSL_REJECT_UNAUTHORIZED === "false" ? false : true,
      },
    },
  });
} else {
  // Local Development Fallback (isolated from live site data)
  console.log("🛠️ Using local development database (isolated from live production site)...");
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage: path.join(__dirname, "local-database.sqlite"),
    logging: false,
  });
}

sequelize.isProductionDb = shouldUseRemoteDb;

module.exports = sequelize;
