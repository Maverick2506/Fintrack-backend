const express = require("express");
const { SavingsGoal } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.use(authMiddleware);

router.get("/savings-goals", async (req, res) => {
  try {
    const goals = await SavingsGoal.findAll();
    res.json(goals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/savings-goals", async (req, res) => {
  try {
    const newGoal = await SavingsGoal.create(req.body);
    res.status(201).json(newGoal);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/savings-goals/:id", async (req, res) => {
  try {
    const goal = await SavingsGoal.findByPk(req.params.id);
    if (goal) {
      await goal.destroy();
      res.status(204).send();
    } else {
      res.status(404).send("Savings Goal not found");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/savings-goals/:id/contribute", async (req, res) => {
  try {
    const goal = await SavingsGoal.findByPk(req.params.id);
    if (goal) {
      goal.current_amount =
        parseFloat(goal.current_amount) + parseFloat(req.body.amount);
      await goal.save();
      res.json(goal);
    } else {
      res.status(404).send("Goal not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put("/savings-goals/:id", async (req, res) => {
  try {
    const goal = await SavingsGoal.findByPk(req.params.id);
    if (goal) {
      await goal.update(req.body);
      res.json(goal);
    } else {
      res.status(404).send("Savings Goal not found");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
