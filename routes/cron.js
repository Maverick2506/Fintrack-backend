const express = require("express");
const cronAuthMiddleware = require("../middleware/cronAuthMiddleware");
const { runDailySweep } = require("../services/dailySweepService");
const { createRecurringExpenses } = require("./recurring");
const { buildMorningDigest } = require("../services/notificationService");
const { Account, Transaction, Setting, Budget, NetWorthSnapshot } = require("../models");

const router = express.Router();

const handleDailyCheck = async (req, res) => {
  try {
    const result = await runDailySweep();
    res.status(200).json({
      message: "Daily sweep completed successfully.",
      result,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to execute daily sweep." });
  }
};

const handleTriggerRecurring = async (req, res) => {
  try {
    await createRecurringExpenses();
    res.status(200).json({
      message: "Recurring transactions generated successfully.",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to execute recurring transactions generation." });
  }
};

const handleDigest = async (req, res) => {
  try {
    const digest = await buildMorningDigest();
    if (!digest) {
      return res.status(204).send();
    }
    res.status(200).json(digest);
  } catch (error) {
    console.error("Digest error:", error);
    res.status(500).json({ error: "Failed to build morning digest." });
  }
};

const handleBackup = async (req, res) => {
  try {
    const [accounts, transactions, settings, budgets, netWorthSnapshots] = await Promise.all([
      Account.findAll({ raw: true, order: [["id", "ASC"]] }),
      Transaction.findAll({ raw: true, order: [["id", "ASC"]] }),
      Setting.findAll({ raw: true, order: [["key", "ASC"]] }),
      Budget.findAll({ raw: true, order: [["category", "ASC"]] }),
      NetWorthSnapshot.findAll({ raw: true, order: [["date", "ASC"]] }),
    ]);

    res.status(200).json({
      format: "fintrack-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts,
      transactions,
      settings,
      budgets,
      netWorthSnapshots,
    });
  } catch (error) {
    console.error("Backup error:", error);
    res.status(500).json({ error: "Failed to generate database backup." });
  }
};

// Support both GET and POST for cron jobs and external webhooks with explicit cron auth
router.all("/daily-check", cronAuthMiddleware, handleDailyCheck);
router.all("/trigger-recurring", cronAuthMiddleware, handleTriggerRecurring);
router.all("/backup", cronAuthMiddleware, handleBackup);
router.all("/digest", cronAuthMiddleware, handleDigest);

// Backwards-compatible aliases
router.all("/cron/daily-check", cronAuthMiddleware, handleDailyCheck);
router.all("/cron/trigger-recurring", cronAuthMiddleware, handleTriggerRecurring);
router.all("/cron/backup", cronAuthMiddleware, handleBackup);
router.all("/cron/digest", cronAuthMiddleware, handleDigest);

module.exports = router;
