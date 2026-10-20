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
 * @param {object} [options.models] - Optional custom models { Account, Transaction, Setting }
 * @returns {Promise<{accountsRestored: number, transactionsRestored: number, settingsRestored: number}>}
 */
async function restoreBackup(backupData, options = {}) {
  const { force = false, production = false, sequelizeInstance, models } = options;

  const db = sequelizeInstance || require("../database");
  if (db.isProductionDb && !production) {
    throw new Error("Target is the remote database; re-run with --production to confirm.");
  }

  const Account = models?.Account || require("../models").Account;
  const Transaction = models?.Transaction || require("../models").Transaction;
  const Setting = models?.Setting || require("../models").Setting;

  if (!backupData || backupData.format !== "fintrack-backup" || backupData.version !== 1) {
    throw new Error('Invalid backup format. Expected "format": "fintrack-backup", "version": 1.');
  }

  if (!Array.isArray(backupData.accounts) || !Array.isArray(backupData.transactions)) {
    throw new Error('Malformed backup payload: "accounts" and "transactions" must be arrays.');
  }

  // Ensure tables exist before inspecting counts or inserting
  await db.sync();

  const existingTxCount = await Transaction.count();
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

  // Perform wipe (if forced) and insertions in a single transaction
  await db.transaction(async (t) => {
    if ((existingTxCount > 0 || existingAccCount > 0) && force) {
      await Transaction.destroy({ where: {}, transaction: t });
      await Account.destroy({ where: {}, transaction: t });
      await Setting.destroy({ where: {}, transaction: t });
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
  });

  return {
    accountsRestored: cleanAccounts.length,
    transactionsRestored: cleanTransactions.length,
    settingsRestored: cleanSettings.length,
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
        console.log("ℹ️ Target database is local development database.");
      }

      const result = await restoreBackup(backupData, { force, production });
      console.log("✅ Database restore completed successfully in a single transaction:");
      console.log(`   - Accounts restored: ${result.accountsRestored}`);
      console.log(`   - Transactions restored: ${result.transactionsRestored}`);
      console.log(`   - Settings restored: ${result.settingsRestored}`);
      process.exit(0);
    } catch (err) {
      console.error("❌ Restore failed:", err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  restoreBackup,
};
