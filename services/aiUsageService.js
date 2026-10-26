const { AiUsage, Setting } = require("../models");

// Daily AI call cap (AI8): one count per request that reaches Gemini, shared by Ask FinTrack, the
// advice card and category suggestions. Days are Toronto days.
const AI_DAILY_CAP_KEY = "ai_daily_cap";
const DEFAULT_AI_DAILY_CAP = 100;

const getDailyCap = async () => {
  const record = await Setting.findByPk(AI_DAILY_CAP_KEY);
  const cap = record ? parseInt(record.value, 10) : NaN;
  return Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_AI_DAILY_CAP;
};

const toInt = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0);

/** Today's calls and tokens, with the cap. A day with no calls is all zeros. */
const getUsage = async (todayStr) => {
  const [row, cap] = await Promise.all([AiUsage.findByPk(todayStr), getDailyCap()]);
  const calls = row ? toInt(row.calls) : 0;
  return {
    date: todayStr,
    calls,
    cap,
    remaining: Math.max(0, cap - calls),
    promptTokens: row ? toInt(row.promptTokens) : 0,
    outputTokens: row ? toInt(row.outputTokens) : 0,
    totalTokens: row ? toInt(row.totalTokens) : 0,
  };
};

// Two requests at once may both try to create today's row; the loser just uses the winner's
const ensureDayRow = async (todayStr) => {
  try {
    await AiUsage.findOrCreate({ where: { date: todayStr }, defaults: { date: todayStr } });
  } catch (err) {
    if (err.name !== "SequelizeUniqueConstraintError") throw err;
  }
};

const capReachedMessage = (cap) =>
  `You've reached today's limit of ${cap} AI requests. It resets at midnight (Toronto time). ` +
  "Everything else in FinTrack still works.";

/**
 * Counts one AI request for today, or refuses it when the cap is reached.
 * Returns { allowed: true } or { allowed: false, cap, message }.
 */
const reserveCall = async (todayStr) => {
  const usage = await getUsage(todayStr);
  if (usage.calls >= usage.cap) {
    return { allowed: false, cap: usage.cap, message: capReachedMessage(usage.cap) };
  }
  await ensureDayRow(todayStr);
  await AiUsage.increment({ calls: 1 }, { where: { date: todayStr } });
  return { allowed: true };
};

/** Sends the friendly 429 for a refused reservation */
const sendCapReached = (res, reservation) =>
  res.status(429).json({ error: reservation.message, code: "AI_DAILY_CAP", cap: reservation.cap });

/**
 * Logs the token counts Gemini reports for one generateContent call and adds them to today's row.
 * Never throws: usage tracking must not break an AI answer.
 */
const recordTokens = async (todayStr, endpoint, model, usageMetadata) => {
  if (!usageMetadata) return;
  const promptTokens = toInt(usageMetadata?.promptTokenCount);
  // Thinking tokens are billed as output
  const outputTokens =
    toInt(usageMetadata?.candidatesTokenCount) + toInt(usageMetadata?.thoughtsTokenCount);
  const totalTokens = toInt(usageMetadata?.totalTokenCount) || promptTokens + outputTokens;
  console.log(
    `[AI usage] ${todayStr} ${endpoint} model=${model} prompt=${promptTokens} output=${outputTokens} total=${totalTokens}`
  );
  if (!totalTokens) return;
  try {
    await ensureDayRow(todayStr);
    await AiUsage.increment(
      { promptTokens, outputTokens, totalTokens },
      { where: { date: todayStr } }
    );
  } catch (err) {
    console.error("Failed to record AI token usage:", err.message);
  }
};

module.exports = {
  AI_DAILY_CAP_KEY,
  DEFAULT_AI_DAILY_CAP,
  getDailyCap,
  getUsage,
  reserveCall,
  sendCapReached,
  recordTokens,
};
