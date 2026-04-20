const express = require("express");
const { Transaction, Account } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/paycheques", async (req, res) => {
  try {
    const incomes = await Transaction.findAll({
        where: { type: "INCOME" },
        order: [["date", "ASC"]],
    });
    
    // Map to frontend expected shape
    const formatted = incomes.map(i => ({
        ...i.toJSON(),
        name: i.title,
        payment_date: i.date
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Since paycheque route in frontend sends name/amount/payment_date
router.post("/paycheques", async (req, res) => {
  try {
    const { name, amount, payment_date, recurrence } = req.body;
    let checking = await Account.findOne({ where: { name: "Primary Checking" } });

    const newIncome = await Transaction.create({
      title: name,
      amount: parseFloat(amount),
      date: payment_date,
      type: "INCOME",
      category: "Income",
      isCleared: true,
      toAccountId: checking ? checking.id : null,
      recurrence: recurrence || "none"
    });
    
    res.status(201).json({
        ...newIncome.toJSON(),
        name: newIncome.title,
        payment_date: newIncome.date
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/paycheques/:id", async (req, res) => {
  try {
    const trx = await Transaction.findByPk(req.params.id);
    if (trx) {
      await trx.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
