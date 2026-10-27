const { Op } = require("sequelize");
const { Setting, Transaction } = require("../models");
const { toZonedTime, format } = require("date-fns-tz");

const TIMEZONE = "America/Toronto";
const anchorKey = (accountId) => `balance_anchor:${accountId}`;
const torontoDate = (d) => format(toZonedTime(d, TIMEZONE), "yyyy-MM-dd", { timeZone: TIMEZONE });

// The last date this account's balance was set: when it was created with a balance, typed in
// (card or checking edit), adjusted to $0, or synced with a statement. Its balance already includes
// everything dated on or before it, so a bank import treats those rows as history (no balance change).
const getBalanceAnchor = async (account, dbTx = null) => {
  const dates = [];
  if (account.createdAt) dates.push(torontoDate(new Date(account.createdAt)));
  const saved = await Setting.findByPk(anchorKey(account.id), { transaction: dbTx });
  if (saved?.value) dates.push(saved.value);
  // Syncs recorded before the anchor was stored
  const lastSync = await Transaction.findOne({
    attributes: ["date"],
    where: {
      title: { [Op.like]: "Statement sync – %" },
      [Op.or]: [{ fromAccountId: account.id }, { toAccountId: account.id }],
    },
    order: [["date", "DESC"]],
    transaction: dbTx,
  });
  if (lastSync) dates.push(lastSync.date);
  return dates.length ? dates.sort().pop() : null;
};

// Records that the balance was set as of `date`. The anchor only moves forward: syncing an older
// statement doesn't make newer rows count again.
const setBalanceAnchor = async (accountId, date, dbTx = null) => {
  const key = anchorKey(accountId);
  const saved = await Setting.findByPk(key, { transaction: dbTx });
  if (saved) {
    if (saved.value >= date) return;
    await saved.update({ value: date }, { transaction: dbTx });
  } else {
    await Setting.create({ key, value: date }, { transaction: dbTx });
  }
};

module.exports = { getBalanceAnchor, setBalanceAnchor, anchorKey };
