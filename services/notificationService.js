const { Account, Transaction, Setting, Budget } = require("../models");
const { Op } = require("sequelize");
const { getTodayString } = require("./accountBalanceService");
const { addCalendarDays, getForecast } = require("./forecastService");
const { toZonedTime } = require("date-fns-tz");

const LOW_BALANCE_WINDOW_DAYS = 14;
const NO_INCOME_NOTE = "No income in your forecast — log your paycheques or set Expected pay";

/**
 * The lowest day below the buffer within the alert window (the next LOW_BALANCE_WINDOW_DAYS days,
 * or the days before the next projected payday if sooner), or null when there's no such dip.
 */
const lowBalanceDip = (forecast) => {
  const windowEnd = addCalendarDays(forecast.today, LOW_BALANCE_WINDOW_DAYS);
  let lowest = null;
  for (const day of forecast.days) {
    if (day.date > windowEnd) break;
    if (forecast.nextPayday && day.date >= forecast.nextPayday) break;
    if (day.balance < forecast.buffer && (!lowest || day.balance < lowest.balance)) {
      lowest = { date: day.date, balance: day.balance };
    }
  }
  return lowest;
};

/**
 * Builds the morning notification digest for ntfy.
 * Returns { title, message, priority, tags } or null if nothing to report.
 *
 * @param {import("sequelize").Transaction|null} [dbTx=null]
 * @returns {Promise<{ title: string, message: string, priority: string, tags: string } | null>}
 */
const buildMorningDigest = async (dbTx = null, options = {}) => {
  // options.todayStr overrides "today" (America/Toronto) so tests can use fixed dates
  const todayStr = options.todayStr || getTodayString();
  const threeDaysAhead = addCalendarDays(todayStr, 3);
  const fiveDaysAhead = addCalendarDays(todayStr, 5);

  // 1. Check privacy preference (Setting NOTIFY_DETAIL: "amounts" | "counts")
  const notifyDetailSetting = await Setting.findByPk("NOTIFY_DETAIL", { transaction: dbTx });
  const showAmounts = notifyDetailSetting ? notifyDetailSetting.value !== "counts" : true;

  const sections = [];
  let isHighPriority = false;

  // 2. Bills due in next 3 days (strictly <= 3 days, not 4 days)
  const dueBills = await Transaction.findAll({
    where: {
      isCleared: false,
      type: { [Op.in]: ["EXPENSE", "TRANSFER"] },
      date: {
        [Op.gte]: todayStr,
        [Op.lte]: threeDaysAhead,
      },
    },
    order: [["date", "ASC"]],
    transaction: dbTx,
  });

  if (dueBills.length > 0) {
    const totalBillsAmt = dueBills.reduce(
      (sum, b) => sum + (parseFloat(b.amount) || 0),
      0
    );
    if (showAmounts) {
      sections.push(
        `📅 Bills Due (Next 3 Days): ${dueBills.length} bill(s) totaling $${totalBillsAmt.toFixed(2)}`
      );
      for (const bill of dueBills) {
        sections.push(`  • ${bill.title}: $${parseFloat(bill.amount).toFixed(2)} (due ${bill.date})`);
      }
    } else {
      sections.push(`📅 Bills Due (Next 3 Days): ${dueBills.length} bill(s) due`);
    }
  }

  // 3. Cards with due date in next 5 days
  const dueCards = await Account.findAll({
    where: {
      type: "CREDIT_CARD",
      isActive: { [Op.ne]: false },
      dueDate: {
        [Op.gte]: todayStr,
        [Op.lte]: fiveDaysAhead,
      },
    },
    transaction: dbTx,
  });

  const cardsWithBalance = dueCards.filter(
    (c) => parseFloat(c.initialBalance || 0) > 0
  );

  if (cardsWithBalance.length > 0) {
    sections.push(`💳 Credit Cards Due (Next 5 Days):`);
    for (const card of cardsWithBalance) {
      const bal = parseFloat(card.initialBalance || 0);
      if (showAmounts) {
        sections.push(`  • ${card.name}: $${bal.toFixed(2)} balance (due ${card.dueDate})`);
      } else {
        sections.push(`  • ${card.name} payment due on ${card.dueDate}`);
      }
    }
  }

  // 4. Forecast & Low-Balance Alert
  //    With no income in the forecast, every bill looks like a dip, so say that instead.
  //    Otherwise only a dip soon matters: within LOW_BALANCE_WINDOW_DAYS, or before the next
  //    projected payday if that comes first.
  try {
    const forecast = await getForecast(60, dbTx, [], options.todayStr ? { todayStr: options.todayStr } : {});
    if (forecast.incomeSource === "none") {
      sections.push(NO_INCOME_NOTE);
    } else {
      const lowest = lowBalanceDip(forecast);
      if (lowest) {
        isHighPriority = true;
        if (showAmounts) {
          sections.push(
            `⚠️ Low Balance Alert: Lowest projected balance is $${lowest.balance.toFixed(2)} on ${lowest.date} (below $${forecast.buffer.toFixed(2)} buffer). Safe to spend is $${forecast.safeToSpend.toFixed(2)}.`
          );
        } else {
          sections.push(
            `⚠️ Low Balance Alert: Projected checking balance dips below buffer on ${lowest.date}.`
          );
        }
      }
    }
  } catch (err) {
    console.error("Forecast error while building digest:", err);
  }

  // 5. Auto-pays and bills sweep processed in the last 24h
  const sweepSetting = await Setting.findByPk("last_sweep_summary", { transaction: dbTx });
  if (sweepSetting && sweepSetting.value) {
    try {
      const sweepData = JSON.parse(sweepSetting.value);
      const hoursAgo = (Date.now() - new Date(sweepData.timestamp).getTime()) / (1000 * 60 * 60);
      if (hoursAgo <= 24 && (sweepData.clearedExpenses > 0 || sweepData.autoPayProcessed > 0)) {
        sections.push(
          `🔄 Daily Sweep Activity: Cleared ${sweepData.clearedExpenses || 0} bill(s) and processed ${sweepData.autoPayProcessed || 0} auto-pay(s).`
        );
      }
    } catch {
      // Ignore parse failure
    }
  }

  // 6. Over-budget categories for the current month
  const budgets = await Budget.findAll({ transaction: dbTx });
  if (budgets.length > 0) {
    const [y, m] = todayStr.split("-").map(Number);
    const startOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDayOfMonth = new Date(y, m, 0).getDate();
    const endOfMonth = `${y}-${String(m).padStart(2, "0")}-${String(lastDayOfMonth).padStart(2, "0")}`;

    const clearedSpending = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        isCleared: true,
        date: { [Op.gte]: startOfMonth, [Op.lte]: endOfMonth },
      },
      attributes: ["category", "amount"],
      transaction: dbTx,
    });

    const categoryTotals = {};
    for (const trx of clearedSpending) {
      const cat = trx.category || "Other";
      categoryTotals[cat] = (categoryTotals[cat] || 0) + (parseFloat(trx.amount) || 0);
    }

    const overBudgets = [];
    for (const b of budgets) {
      const spent = categoryTotals[b.category] || 0;
      const limit = parseFloat(b.monthlyLimit) || 0;
      if (limit > 0 && spent > limit) {
        overBudgets.push({ category: b.category, spent, limit });
      }
    }

    if (overBudgets.length > 0) {
      sections.push(`📊 Over-Budget Alert:`);
      for (const ob of overBudgets) {
        if (showAmounts) {
          sections.push(`  • ${ob.category}: $${ob.spent.toFixed(2)} spent of $${ob.limit.toFixed(2)} limit`);
        } else {
          sections.push(`  • ${ob.category} has exceeded its monthly limit`);
        }
      }
    }
  }

  // 7. Sunday Weekly AI Summary (G16)
  const torontoNow = toZonedTime(new Date(), "America/Toronto");
  const isSunday = torontoNow.getDay() === 0;
  if (isSunday && process.env.GEMINI_API_KEY && sections.length > 0) {
    try {
      const { GoogleGenAI } = require("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `Maverick has received their morning digest with these points:
${sections.join("\n")}
Provide a 2-sentence encouraging weekly wrap-up highlighting their top focus for this week. Keep it very punchy and concise. No markdown headers or disclaimers.`;
      const aiRes = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL_FAST || "gemini-3.5-flash",
        contents: prompt,
        config: {
          abortSignal: AbortSignal.timeout(6000),
        },
      });
      const summaryText = (aiRes.text || "").trim();
      if (summaryText) {
        sections.push(`💡 Weekly Focus: ${summaryText}`);
      }
    } catch (err) {
      console.error("Sunday AI digest summary error:", err.message);
    }
  }

  // If there's nothing to report, return null (HTTP 204)
  if (sections.length === 0) {
    return null;
  }

  const title = isHighPriority
    ? `⚠️ FinTrack Alert · Action Needed`
    : `FinTrack Morning Digest · ${todayStr}`;
  const message = sections.join("\n");
  const priority = isHighPriority ? "high" : "default";
  const tags = isHighPriority ? "warning,money_with_wings" : "calendar,clipboard";

  return {
    title,
    message,
    priority,
    tags,
  };
};

module.exports = {
  LOW_BALANCE_WINDOW_DAYS,
  NO_INCOME_NOTE,
  lowBalanceDip,
  buildMorningDigest,
};
