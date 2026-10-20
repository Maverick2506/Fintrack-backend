const express = require("express");
const { Op } = require("sequelize");
const { subMonths, subDays, parseISO, format } = require("date-fns");
const authMiddleware = require("../middleware/authMiddleware");
const { NetWorthSnapshot } = require("../models");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const rawMonths = parseInt(req.query.months, 10);
    const months = !isNaN(rawMonths) && rawMonths > 0 ? Math.min(rawMonths, 120) : 12;

    const cutoffDate = format(subMonths(new Date(), months), "yyyy-MM-dd");

    const snapshots = await NetWorthSnapshot.findAll({
      where: {
        date: { [Op.gte]: cutoffDate },
      },
      order: [["date", "ASC"]],
    });

    const parsedSnapshots = snapshots.map((s) => ({
      id: s.id,
      date: s.date,
      checking: Math.round(parseFloat(s.checking || 0) * 100) / 100,
      savings: Math.round(parseFloat(s.savings || 0) * 100) / 100,
      debt: Math.round(parseFloat(s.debt || 0) * 100) / 100,
      cards: Math.round(parseFloat(s.cards || 0) * 100) / 100,
      netWorth: Math.round(parseFloat(s.netWorth || 0) * 100) / 100,
      createdAt: s.createdAt,
    }));

    let change30Days = null;
    if (parsedSnapshots.length >= 2) {
      const latest = parsedSnapshots[parsedSnapshots.length - 1];
      const targetDate = format(subDays(parseISO(latest.date), 30), "yyyy-MM-dd");

      // Find the snapshot closest to or immediately prior to 30 days ago
      let baselineSnapshot = null;
      for (let i = parsedSnapshots.length - 2; i >= 0; i--) {
        if (parsedSnapshots[i].date <= targetDate) {
          baselineSnapshot = parsedSnapshots[i];
          break;
        }
      }

      if (baselineSnapshot) {
        const absolute = Math.round((latest.netWorth - baselineSnapshot.netWorth) * 100) / 100;
        let percentage = null;
        if (baselineSnapshot.netWorth !== 0) {
          percentage =
            Math.round(
              ((latest.netWorth - baselineSnapshot.netWorth) /
                Math.abs(baselineSnapshot.netWorth)) *
                10000
            ) / 100;
        }
        change30Days = {
          absolute,
          percentage,
          priorDate: baselineSnapshot.date,
        };
      }
    }

    res.json({
      snapshots: parsedSnapshots,
      change30Days,
    });
  } catch (error) {
    console.error("Error fetching net worth history:", error);
    res.status(500).json({ error: "Failed to fetch net worth history." });
  }
});

module.exports = router;
