const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/credit-cards", async (req, res) => {
  try {
    const cards = await Account.findAll({
      where: { type: "CREDIT_CARD" },
      order: [["createdAt", "ASC"]],
    });
    const formatted = cards.map((c) => ({
      ...c.toJSON(),
      currentBalance: c.initialBalance,
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/credit-cards", async (req, res) => {
  try {
    const { name, creditLimit, currentBalance, dueDate } = req.body;
    if (!name || creditLimit === undefined) {
      return res
        .status(400)
        .json({ error: "Name and Credit Limit are required." });
    }

    const newCard = await Account.create({
      name,
      type: "CREDIT_CARD",
      initialBalance: currentBalance || 0.0,
      creditLimit: parseFloat(creditLimit),
      dueDate: dueDate || null,
    });

    res
      .status(201)
      .json({ ...newCard.toJSON(), currentBalance: newCard.initialBalance });
  } catch (error) {
    res.status(400).json({ error: "Failed to create credit card." });
  }
});

router.post("/credit-cards/:id/pay", async (req, res) => {
  const dbTx = await sequelize.transaction();
  try {
    const card = await Account.findByPk(req.params.id, { transaction: dbTx });
    const [checking] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 },
      transaction: dbTx,
    });

    if (!card || !checking) {
      await dbTx.rollback();
      return res.status(404).send("Credit Card or Checking Account not found");
    }

    const paymentAmount = parseFloat(req.body.amount);
    card.initialBalance = Math.max(
      0,
      parseFloat(card.initialBalance) - paymentAmount
    );
    await card.save({ transaction: dbTx });

    await Transaction.create(
      {
        title: `Payment for ${card.name}`,
        amount: paymentAmount,
        date: new Date(),
        type: "TRANSFER",
        category: "Credit Card Payment",
        isCleared: true,
        fromAccountId: checking.id,
        toAccountId: card.id,
      },
      { transaction: dbTx }
    );

    await dbTx.commit();
    res.json({ ...card.toJSON(), currentBalance: card.initialBalance });
  } catch (error) {
    await dbTx.rollback();
    res.status(400).json({ error: error.message });
  }
});

router.delete("/credit-cards/:id", async (req, res) => {
  try {
    const card = await Account.findByPk(req.params.id);
    if (card) {
      await card.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Credit Card not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/credit-cards/:id", async (req, res) => {
  try {
    const card = await Account.findByPk(req.params.id);
    if (card) {
      const { name, creditLimit, currentBalance, initialBalance, dueDate } =
        req.body;
      await card.update({
        name: name !== undefined ? name : card.name,
        creditLimit:
          creditLimit !== undefined
            ? parseFloat(creditLimit)
            : card.creditLimit,
        initialBalance:
          currentBalance !== undefined
            ? parseFloat(currentBalance)
            : initialBalance !== undefined
            ? parseFloat(initialBalance)
            : card.initialBalance,
        dueDate: dueDate !== undefined ? dueDate : card.dueDate,
      });
      res.json({ ...card.toJSON(), currentBalance: card.initialBalance });
    } else {
      res.status(404).send("Credit Card not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
