const { Transaction } = require("../models");
const { getNextOccurrenceDate } = require("../routes/recurring");

const getPaychequeProjection = async (todayStr, currentMonthPrefix, dbTx = null) => {
  let totalProjectedIncome = 0;
  let projectedPaychequeDates = [];

  const recentPaycheques = await Transaction.findAll({
    where: { type: "INCOME" },
    order: [["date", "DESC"]],
    limit: 5,
    transaction: dbTx,
  });

  if (recentPaycheques.length > 0) {
    const avgAmt =
      recentPaycheques.reduce((sum, p) => sum + parseFloat(p.amount), 0) /
      recentPaycheques.length;

    let cadence = "bi-weekly";
    if (
      recentPaycheques[0].recurrence &&
      ["weekly", "bi-weekly", "monthly"].includes(recentPaycheques[0].recurrence)
    ) {
      cadence = recentPaycheques[0].recurrence;
    } else if (recentPaycheques.length >= 2) {
      const [y1, m1, d1] = recentPaycheques[0].date.split("-").map(Number);
      const [y2, m2, d2] = recentPaycheques[1].date.split("-").map(Number);
      const diffDays = Math.round(
        Math.abs(Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) /
          (1000 * 60 * 60 * 24)
      );
      if (diffDays >= 6 && diffDays <= 8) cadence = "weekly";
      else if (diffDays >= 12 && diffDays <= 17) cadence = "bi-weekly";
      else if (diffDays >= 27) cadence = "monthly";
    }

    let step = 1;
    while (step <= 10) {
      const nextDateStr = getNextOccurrenceDate(recentPaycheques[0].date, cadence, step);
      if (!nextDateStr) break;
      if (nextDateStr.startsWith(currentMonthPrefix)) {
        if (nextDateStr > todayStr) {
          projectedPaychequeDates.push(nextDateStr);
          totalProjectedIncome += avgAmt;
        }
      } else if (nextDateStr > todayStr) {
        break;
      }
      step++;
    }
  }

  return {
    totalProjectedIncome: Math.round(totalProjectedIncome * 100) / 100,
    projectedPaychequeDates,
  };
};

module.exports = {
  getPaychequeProjection,
};
