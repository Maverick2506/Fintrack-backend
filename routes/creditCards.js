const express = require("express");
const { CreditCard, Expense } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

// Get all credit cards
router.get("/credit-cards", async (req, res) => {
  try {
    const cards = await CreditCard.findAll();
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a new credit card with corrected validation
router.post("/credit-cards", async (req, res) => {
  try {
    // Expect the new field names from the frontend
    const { name, creditLimit, currentBalance, dueDate } = req.body;

    if (!name || creditLimit === undefined) {
      return res
        .status(400)
        .json({ error: "Name and Credit Limit are required." });
    }

    const parsedCreditLimit = parseFloat(creditLimit);
    if (isNaN(parsedCreditLimit)) {
      return res
        .status(400)
        .json({ error: "Credit Limit must be a valid number." });
    }

    const parsedCurrentBalance = currentBalance
      ? parseFloat(currentBalance)
      : 0.0;
    if (isNaN(parsedCurrentBalance)) {
      return res
        .status(400)
        .json({ error: "Current Balance must be a valid number." });
    }

    const payload = {
      name,
      creditLimit: parsedCreditLimit,
      currentBalance: parsedCurrentBalance,
      dueDate: dueDate || null,
    };

    const newCard = await CreditCard.create(payload);
    res.status(201).json(newCard);
  } catch (error) {
    console.error("Error creating credit card:", error);
    res.status(400).json({ error: "Failed to create credit card." });
  }
});

// Log a payment to a credit card
router.post("/credit-cards/:id/pay", async (req, res) => {
  try {
    const card = await CreditCard.findByPk(req.params.id);
    if (card) {
      const paymentAmount = parseFloat(req.body.amount);
      // Update the correct field name
      card.currentBalance = parseFloat(card.currentBalance) - paymentAmount;
      await card.save();

      await Expense.create({
        name: `Payment for ${card.name}`,
        amount: paymentAmount,
        due_date: new Date(),
        is_paid: true,
        category: "Debt",
      });

      res.json(card);
    } else {
      res.status(404).send("Credit Card not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete a credit card
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

router.put("/credit-cards/:id", async (req, res) => {
  try {
    const card = await CreditCard.findByPk(req.params.id);
    if (card) {
      await card.update(req.body);
      res.json(card);
    } else {
      res.status(404).send("Credit Card not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
