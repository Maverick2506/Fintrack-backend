const { Op } = require("sequelize");
const { Transaction } = require("../models");

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Cleared income and spending per month between two dates (inclusive), with spending by category.
 * Shared by /api/trends and Ask FinTrack's compareMonths tool. Deleted (Trash) rows are left out.
 * Returns { "YYYY-MM": { income, spending, byCategory: { [category]: total } } } for months that have rows.
 */
const getClearedMonthTotals = async (startDate, endDate) => {
  const rows = await Transaction.findAll({
    attributes: ["type", "date", "amount", "category"],
    where: {
      type: { [Op.in]: ["INCOME", "EXPENSE"] },
      isCleared: true,
      date: { [Op.between]: [startDate, endDate] },
    },
    raw: true,
  });

  const months = {};
  for (const r of rows) {
    const ym = String(r.date).slice(0, 7);
    if (!months[ym]) months[ym] = { income: 0, spending: 0, byCategory: {} };
    const month = months[ym];
    const amt = parseFloat(r.amount) || 0;
    if (r.type === "INCOME") {
      month.income += amt;
    } else {
      month.spending += amt;
      const cat = r.category || "Other";
      month.byCategory[cat] = (month.byCategory[cat] || 0) + amt;
    }
  }
  return months;
};

const isMonthStr = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ""));

const monthRange = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(lastDay).padStart(2, "0")}`];
};

/**
 * Category totals of two months and the change from monthA to monthB (positive = spent more in B).
 * Categories are sorted by the size of the change.
 */
const compareMonths = async (monthA, monthB) => {
  const [aStart, aEnd] = monthRange(monthA);
  const [bStart, bEnd] = monthRange(monthB);
  const [aTotals, bTotals] = await Promise.all([
    getClearedMonthTotals(aStart, aEnd),
    getClearedMonthTotals(bStart, bEnd),
  ]);
  const a = aTotals[monthA] || { income: 0, spending: 0, byCategory: {} };
  const b = bTotals[monthB] || { income: 0, spending: 0, byCategory: {} };

  const names = [...new Set([...Object.keys(a.byCategory), ...Object.keys(b.byCategory)])];
  const categories = names
    .map((category) => {
      const totalA = round2(a.byCategory[category] || 0);
      const totalB = round2(b.byCategory[category] || 0);
      return { category, [monthA]: totalA, [monthB]: totalB, difference: round2(totalB - totalA) };
    })
    .sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference) || x.category.localeCompare(y.category));

  return {
    monthA,
    monthB,
    spending: { [monthA]: round2(a.spending), [monthB]: round2(b.spending), difference: round2(b.spending - a.spending) },
    income: { [monthA]: round2(a.income), [monthB]: round2(b.income), difference: round2(b.income - a.income) },
    categories,
  };
};

module.exports = { getClearedMonthTotals, compareMonths, isMonthStr, monthRange };
