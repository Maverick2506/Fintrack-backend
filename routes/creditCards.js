const express = require("express");
const { CreditCard, Expense } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

// GET all credit cards
router.get("/credit-cards", async (req, res) => {
  try {
    const cards = await CreditCard.findAll();
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST a new credit card
router.post("/credit-cards", async (req, res) => {
  try {
    const newCard = await CreditCard.create(req.body);
    res.status(201).json(newCard);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST a payment to a credit card
router.post("/credit-cards/:id/pay", async (req, res) => {
  try {
    const card = await CreditCard.findByPk(req.params.id);
    if (card) {
      const paymentAmount = parseFloat(req.body.amount);
      card.balance = parseFloat(card.balance) - paymentAmount;
      await card.save();

      // Create a corresponding expense for the payment
      await Expense.create({
        name: `Payment for ${card.name}`,
        amount: paymentAmount,
        due_date: new Date(),
        is_paid: true,
        category: "Debt", // Or a new 'Credit Card Payment' category
      });

      res.json(card);
    } else {
      res.status(404).send("Credit Card not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE a credit card
router.delete("/credit-cards/:id", async (req, res) => {
  try {
    const card = await CreditCard.findByPk(req.params.id);
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

module.exports = router;
