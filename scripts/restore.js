const fs = require("fs");
const path = require("path");

// Load .env if present (same mechanism as server.js)
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

/**
 * Restores backup JSON data into the given or default Sequelize database.
 * 
 * @param {object} backupData - Parsed JSON object from a FinTrack backup
 * @param {object} options - Configuration options
 * @param {boolean} options.force - Overwrite if data exists
 * @param {boolean} [options.production] - Explicit confirmation when target is production database
 * @param {object} [options.sequelizeInstance] - Optional Sequelize instance (for testing/custom DB)
 * @param {object} [options.models] - Optional custom models { Account, Transaction, Setting, Budget, NetWorthSnapshot }
 * @returns {Promise<{accountsRestored: number, transactionsRestored: number, settingsRestored: number, budgetsRestored: number, snapshotsRestored: number}>}
 */
async function restoreBackup(backupData, options = {}) {
  const { force = false, production = false, sequelizeInstance, models } = options;

  const db = sequelizeInstance || require("../database");
  if (db.isProductionDb && !production) {
    throw new Error("Target is the remote database; re-run with --production to confirm.");
  }

  const Account = models ? models.Account : require("../models").Account;
  const Transaction = models ? models.Transaction : require("../models").Transaction;
  const Setting = models ? models.Setting : require("../models").Setting;
  const Budget = models ? models.Budget : require("../models").Budget;
  const NetWorthSnapshot = models ? models.NetWorthSnapshot : require("../models").NetWorthSnapshot;

  if (!backupData || backupData.format !== "fintrack-backup" || backupData.version !== 1) {
    throw new Error('Invalid backup format. Expected "format": "fintrack-backup", "version": 1.');
  }

  if (!Array.isArray(backupData.accounts) || !Array.isArray(backupData.transactions)) {
    throw new Error('Malformed backup payload: "accounts" and "transactions" must be arrays.');
  }

  // Ensure tables exist before inspecting counts or inserting
  await db.sync();

  // Rows in the Trash count too: they hold ids and unique keys
  const existingTxCount = await Transaction.count({ paranoid: false });
  const existingAccCount = await Account.count();

  if ((existingTxCount > 0 || existingAccCount > 0) && !force) {
    throw new Error(
      `Target database already contains data (${existingAccCount} accounts, ${existingTxCount} transactions). Refusing to overwrite. Pass --force to wipe and restore.`
    );
  }

  const cleanAccounts = (backupData.accounts || []).map((acc) => ({
    ...acc,
    autoPay: Boolean(acc.autoPay),
    isActive: acc.isActive !== false && acc.isActive !== 0 && acc.isActive !== "0",
  }));

  const cleanTransactions = (backupData.transactions || []).map((tx) => ({
    ...tx,
    isTaxExclusive: Boolean(tx.isTaxExclusive),
    taxApplied: Boolean(tx.taxApplied),
    isCleared: Boolean(tx.isCleared),
    balanceApplied: Boolean(tx.balanceApplied),
  }));

  const cleanSettings = (backupData.settings || []).map((s) => ({
    ...s,
  }));

  const cleanBudgets = (backupData.budgets || []).map((b) => ({
    ...b,
    rollover: Boolean(b.rollover),
  }));

  const cleanSnapshots = (backupData.netWorthSnapshots || []).map((sn) => ({
    ...sn,
  }));

  // Perform wipe (if forced) and insertions in a single transaction
  await db.transaction(async (t) => {
    if ((existingTxCount > 0 || existingAccCount > 0) && force) {
      await Transaction.destroy({ where: {}, force: true, transaction: t });
      await Account.destroy({ where: {}, transaction: t });
      await Setting.destroy({ where: {}, transaction: t });
      if (Budget) await Budget.destroy({ where: {}, transaction: t });
      if (NetWorthSnapshot) await NetWorthSnapshot.destroy({ where: {}, transaction: t });
    }

    if (cleanAccounts.length > 0) {
      await Account.bulkCreate(cleanAccounts, { transaction: t, validate: false });
    }
    if (cleanTransactions.length > 0) {
      await Transaction.bulkCreate(cleanTransactions, { transaction: t, validate: false });
    }
    if (cleanSettings.length > 0) {
      await Setting.bulkCreate(cleanSettings, { transaction: t, validate: false });
    }
    if (cleanBudgets.length > 0 && Budget) {
      await Budget.bulkCreate(cleanBudgets, { transaction: t, validate: false });
    }
    if (cleanSnapshots.length > 0 && NetWorthSnapshot) {
      await NetWorthSnapshot.bulkCreate(cleanSnapshots, { transaction: t, validate: false });
    }
  });

  return {
    accountsRestored: cleanAccounts.length,
    transactionsRestored: cleanTransactions.length,
    settingsRestored: cleanSettings.length,
    budgetsRestored: cleanBudgets.length,
    snapshotsRestored: cleanSnapshots.length,
  };
}

// CLI Execution entrypoint
if (require.main === module) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      const force = args.includes("--force");
      const production = args.includes("--production");
      const filePath = args.find((a) => !a.startsWith("--"));

      if (!filePath) {
        console.error("Usage: node scripts/restore.js <path-to-backup.json> [--force] [--production]");
        process.exit(1);
      }

      const resolvedPath = path.resolve(process.cwd(), filePath);
      if (!fs.existsSync(resolvedPath)) {
        console.error(`Error: Backup file not found at ${resolvedPath}`);
        process.exit(1);
      }

      const rawContent = fs.readFileSync(resolvedPath, "utf-8");
      const backupData = JSON.parse(rawContent);

      const db = require("../database");
      if (db.isProductionDb && !production) {
        console.error("❌ Target is the remote database; re-run with --production to confirm.");
        process.exit(1);
      }

      console.log(`Starting restore from ${resolvedPath}...`);
      if (db.isProductionDb) {
        console.warn("⚠️ WARNING: Target database is REMOTE PRODUCTION (DATABASE_URL)!");
      } else {
        console.log("Target database is local SQLite development database.");
      }

      const summary = await restoreBackup(backupData, { force, production, sequelizeInstance: db });
      console.log("✅ Restore completed successfully:");
      console.log(`   - Accounts: ${summary.accountsRestored}`);
      console.log(`   - Transactions: ${summary.transactionsRestored}`);
      console.log(`   - Settings: ${summary.settingsRestored}`);
      console.log(`   - Budgets: ${summary.budgetsRestored}`);
      console.log(`   - Net Worth Snapshots: ${summary.snapshotsRestored}`);
      process.exit(0);
    } catch (err) {
      console.error("❌ Restore failed:", err.message);
      process.exit(1);
    }
  })();
}

module.exports = { restoreBackup };
