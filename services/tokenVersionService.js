const { Setting } = require("../models");

// "Sign out all devices": every login token carries the token_version it was signed with (tv).
// Bumping the version makes every older token fail authMiddleware. Feed and widget keys are separate.
const SETTING_KEY = "token_version";
const CACHE_MS = 30 * 1000;

let cached = null; // { version, at }

const getTokenVersion = async () => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.version;
  const record = await Setting.findByPk(SETTING_KEY);
  const parsed = Number.parseInt(record?.value, 10);
  const version = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  cached = { version, at: Date.now() };
  return version;
};

const bumpTokenVersion = async () => {
  cached = null;
  const next = (await getTokenVersion()) + 1;
  const [record] = await Setting.findOrCreate({
    where: { key: SETTING_KEY },
    defaults: { value: String(next) },
  });
  if (record.value !== String(next)) {
    record.value = String(next);
    await record.save();
  }
  cached = { version: next, at: Date.now() };
  return next;
};

// Tokens from before this feature have no tv and count as version 0
const isTokenVersionCurrent = async (decoded) => {
  const tv = Number.isInteger(decoded?.tv) ? decoded.tv : 0;
  return tv >= (await getTokenVersion());
};

module.exports = { getTokenVersion, bumpTokenVersion, isTokenVersionCurrent, TOKEN_VERSION_KEY: SETTING_KEY };
