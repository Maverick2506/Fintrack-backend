const express = require("express");
const { CreditCard, Expense } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

// Get all credit cards
router.get("/credit-cards", async (req, res) => {
  try {
    const cards = await CreditCard.findAll({
      include: [{ model: Expense, as: "Expenses" }],
    });
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MODIFIED: Add a new credit card with data validation
router.post("/credit-cards", async (req, res) => {
  try {
    const { name, credit_limit, statement_balance, due_date } = req.body;

    // Build the payload safely
    const payload = {
      name,
      credit_limit: parseFloat(credit_limit),
      statement_balance: statement_balance
        ? parseFloat(statement_balance)
        : 0.0,
      // Explicitly set to null if due_date is empty or not provided
      due_date: due_date ? due_date : null,
    };

    const newCard = await CreditCard.create(payload);
    res.status(201).json(newCard);
  } catch (error) {
    console.error("Error creating credit card:", error);
    res.status(400).json({
      error: "Failed to create credit card. Please check your input.",
    });
  }
});

// Log a payment to a credit card
router.post("/credit-cards/:id/pay", async (req, res) => {
  try {
    const card = await CreditCard.findByPk(req.params.id);
    if (card) {
      const paymentAmount = parseFloat(req.body.amount);
      card.statement_balance =
        parseFloat(card.statement_balance) - paymentAmount;
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

module.exports = router;
