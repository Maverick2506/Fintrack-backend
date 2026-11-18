const { Op } = require("sequelize");
const { sequelize, Account, Transaction, Setting } = require("../models");

const DEBT_PAYMENT_CATEGORY_KEY = "debt_payment_category_v1";

/**
 * One-off: debt payments (TRANSFERs to a DEBT account) used to be saved with the purchase category
 * "Debt". They get the system category "Debt Payment", like card payments have "Credit Card Payment".
 * Purchases in the Debt category (EXPENSE rows) keep it. Trashed rows are relabelled too, so a restore
 * brings back the new label. Runs once, in one transaction with its Setting flag.
 * Returns the number of rows relabelled, or null when it has already run.
 */
const runDebtPaymentCategoryMigration = async () => {
  const done = await Setting.findByPk(DEBT_PAYMENT_CATEGORY_KEY);
  if (done && done.value === "true") return null;
  return sequelize.transaction(async (dbTx) => {
    const debtIds = (
      await Account.findAll({ where: { type: "DEBT" }, attributes: ["id"], transaction: dbTx })
    ).map((a) => a.id);
    let relabelled = 0;
    if (debtIds.length > 0) {
      [relabelled] = await Transaction.update(
        { category: "Debt Payment" },
        {
          where: { type: "TRANSFER", category: "Debt", toAccountId: { [Op.in]: debtIds } },
          paranoid: false,
          silent: true,
          transaction: dbTx,
        }
      );
    }
    await Setting.upsert({ key: DEBT_PAYMENT_CATEGORY_KEY, value: "true" }, { transaction: dbTx });
    return relabelled;
  });
};

module.exports = { runDebtPaymentCategoryMigration, DEBT_PAYMENT_CATEGORY_KEY };
