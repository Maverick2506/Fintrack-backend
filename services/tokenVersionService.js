const { sequelize, Setting } = require("../models");

// "Sign out all devices": every login token carries the token_version it was signed with (tv).
// Bumping the version makes every older token fail authMiddleware. Feed and widget keys are separate.
// Read on every authenticated request (one primary-key lookup), so a bump takes effect at once on
// every server instance.
const SETTING_KEY = "token_version";

const getTokenVersion = async () => {
  const record = await Setting.findByPk(SETTING_KEY);
  const parsed = Number.parseInt(record?.value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

// One UPDATE adds 1, so two sign-outs at the same moment both count (Postgres and SQLite)
const bumpTokenVersion = async () => {
  await Setting.findOrCreate({ where: { key: SETTING_KEY }, defaults: { value: "0" } });
  const table = sequelize.getQueryInterface().quoteIdentifier(Setting.getTableName());
  await sequelize.query(
    `UPDATE ${table} SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), "updatedAt" = CURRENT_TIMESTAMP WHERE key = :key`,
    { replacements: { key: SETTING_KEY } }
  );
  return getTokenVersion();
};

// Tokens from before this feature have no tv and count as version 0. A tv above the stored version
// can't be made without JWT_SECRET, so >= is as strict as === here.
const isTokenVersionCurrent = async (decoded) => {
  const tv = Number.isInteger(decoded?.tv) ? decoded.tv : 0;
  return tv >= (await getTokenVersion());
};

module.exports = { getTokenVersion, bumpTokenVersion, isTokenVersionCurrent, TOKEN_VERSION_KEY: SETTING_KEY };
