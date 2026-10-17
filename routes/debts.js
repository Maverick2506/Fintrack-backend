const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

const formatDebtResponse = (d) => {
  const json = d.toJSON ? d.toJSON() : d;
  return {
    ...json,
    total_amount: json.targetAmount ?? json.initialBalance,
    total_remaining: json.initialBalance,
    monthly_payment: json.minimumPayment,
    next_due_date: json.dueDate,
    auto_pay: Boolean(json.autoPay),
    payment_frequency: json.paymentFrequency || "monthly",
    interest_rate: json.interestRate,
  };
};

router.get("/debts", async (req, res) => {
  try {
    const debts = await Account.findAll({
      where: { type: "DEBT" },
      order: [["createdAt", "ASC"]],
    });
    res.json(debts.map(formatDebtResponse));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/debts", async (req, res) => {
  try {
    const {
      name,
      total_amount,
      monthly_payment,
      auto_pay,
      next_due_date,
      payment_frequency,
      interest_rate,
      interestRate,
    } = req.body;

    const parsedRate =
      interest_rate !== undefined && interest_rate !== ""
        ? parseFloat(interest_rate)
        : interestRate !== undefined && interestRate !== ""
        ? parseFloat(interestRate)
        : null;

    const newDebt = await Account.create({
      name,
      type: "DEBT",
      initialBalance: total_amount,
      targetAmount: total_amount,
      minimumPayment: monthly_payment || null,
      dueDate: next_due_date || null,
      autoPay: Boolean(auto_pay),
      paymentFrequency: payment_frequency || "monthly",
      interestRate: !isNaN(parsedRate) ? parsedRate : null,
    });

    res.status(201).json(formatDebtResponse(newDebt));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/debts/:id/pay", async (req, res) => {
  const dbTx = await sequelize.transaction();
  try {
    const debt = await Account.findByPk(req.params.id, { transaction: dbTx });
    const [checking] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
      transaction: dbTx,
    });

    if (!debt || !checking) {
      await dbTx.rollback();
      return res.status(404).send("Debt or Checking Account not found");
    }

    const paymentAmount = parseFloat(req.body.amount);
    debt.initialBalance = Math.max(
      0,
      parseFloat(debt.initialBalance) - paymentAmount
    );
    await debt.save({ transaction: dbTx });

    await Transaction.create(
      {
        title: `Payment for ${debt.name}`,
        amount: paymentAmount,
        date: new Date(),
        type: "TRANSFER",
        category: "Debt Payment",
        isCleared: true,
        fromAccountId: checking.id,
        toAccountId: debt.id,
      },
      { transaction: dbTx }
    );

    await dbTx.commit();
    res.json(formatDebtResponse(debt));
  } catch (error) {
    await dbTx.rollback();
    res.status(400).json({ error: error.message });
  }
});

router.delete("/debts/:id", async (req, res) => {
  try {
    const debt = await Account.findByPk(req.params.id);
    if (debt) {
      await debt.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Debt not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/debts/:id", async (req, res) => {
  try {
    const debt = await Account.findByPk(req.params.id);
    if (!debt) {
      return res.status(404).send("Debt not found");
    }

    const {
      name,
      total_amount,
      total_remaining,
      monthly_payment,
      auto_pay,
      next_due_date,
      payment_frequency,
      interest_rate,
      interestRate,
    } = req.body;

    const updates = {
      name: name ?? debt.name,
      targetAmount:
        total_amount !== undefined ? total_amount : debt.targetAmount,
      minimumPayment:
        monthly_payment !== undefined ? monthly_payment : debt.minimumPayment,
      dueDate:
        next_due_date !== undefined ? next_due_date || null : debt.dueDate,
    };

    if (total_remaining !== undefined && total_remaining !== "") {
      updates.initialBalance = parseFloat(total_remaining);
    }
    if (auto_pay !== undefined) {
      updates.autoPay = Boolean(auto_pay);
    }
    if (payment_frequency !== undefined) {
      updates.paymentFrequency = payment_frequency || "monthly";
    }
    if (interest_rate !== undefined || interestRate !== undefined) {
      const rawRate =
        interest_rate !== undefined ? interest_rate : interestRate;
      updates.interestRate =
        rawRate === "" || rawRate === null ? null : parseFloat(rawRate);
    }

    await debt.update(updates);
    res.json(formatDebtResponse(debt));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
