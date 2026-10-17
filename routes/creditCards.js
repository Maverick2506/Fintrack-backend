const express = require("express");
const { Account, Transaction } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/credit-cards", async (req, res) => {
  try {
    const cards = await Account.findAll({ where: { type: "CREDIT_CARD" } });
    const formatted = cards.map(c => ({
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
      return res.status(400).json({ error: "Name and Credit Limit are required." });
    }

    const newCard = await Account.create({
      name,
      type: "CREDIT_CARD",
      initialBalance: currentBalance || 0.0,
      creditLimit: parseFloat(creditLimit),
      dueDate: dueDate || null,
    });
    
    res.status(201).json({ ...newCard.toJSON(), currentBalance: newCard.initialBalance });
  } catch (error) {
    res.status(400).json({ error: "Failed to create credit card." });
  }
});

router.post("/credit-cards/:id/pay", async (req, res) => {
  try {
    const card = await Account.findByPk(req.params.id);
    const [checking] = await Account.findOrCreate({
      where: { name: "Primary Checking" },
      defaults: { type: "CHECKING", initialBalance: 0.0 }
    });

    if (card && checking) {
      const paymentAmount = parseFloat(req.body.amount);
      card.initialBalance = parseFloat(card.initialBalance) - paymentAmount;
      await card.save();

      // **CREATE THE TRANSFER TRANSACTION!** (Fulfills user request to visibly log it)
      await Transaction.create({
        title: `Payment for ${card.name}`,
        amount: paymentAmount,
        date: new Date(),
        type: "TRANSFER",
        category: "Credit Card Payment",
        isCleared: true,
        fromAccountId: checking.id,
        toAccountId: card.id,
      });

      res.json({ ...card.toJSON(), currentBalance: card.initialBalance });
    } else {
      res.status(404).send("Credit Card or Checking Account not found");
    }
  } catch (error) {
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
      const { name, creditLimit, currentBalance, initialBalance, dueDate } = req.body;
      await card.update({
        name: name !== undefined ? name : card.name,
        creditLimit: creditLimit !== undefined ? parseFloat(creditLimit) : card.creditLimit,
        initialBalance: currentBalance !== undefined ? parseFloat(currentBalance) : (initialBalance !== undefined ? parseFloat(initialBalance) : card.initialBalance),
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
