const express = require("express");
const { Expense } = require("../models");
const { Op } = require("sequelize");
const router = express.Router();

// This function will find recurring expenses and create new instances for the current month
const createRecurringExpenses = async () => {
  console.log("Running job to create recurring expenses...");
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();

  try {
    // Find all monthly and yearly recurring expenses
    const recurringExpenses = await Expense.findAll({
      where: {
        recurrence: {
          [Op.in]: ["monthly", "yearly"],
        },
      },
    });

    for (const expense of recurringExpenses) {
      const dueDate = new Date(expense.due_date);

      // For yearly expenses, only create if it's the same month
      if (
        expense.recurrence === "yearly" &&
        dueDate.getMonth() !== currentMonth
      ) {
        continue; // Skip if it's not the anniversary month
      }

      const newDueDate = new Date(currentYear, currentMonth, dueDate.getDate());

      // Check if an expense with the same name and due date already exists for this month
      const existing = await Expense.findOne({
        where: {
          name: expense.name,
          due_date: newDueDate,
        },
      });

      // If it doesn't exist, create it
      if (!existing) {
        await Expense.create({
          ...expense.get({ plain: true }), // Get plain data object from the model instance
          id: undefined, // Let the database generate a new ID
          is_paid: false,
          due_date: newDueDate,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`Created recurring expense: ${expense.name}`);
      }
    }
    console.log("Recurring expenses job finished.");
  } catch (error) {
    console.error("Error creating recurring expenses:", error);
  }
};

// You can also create a manual endpoint to trigger this for testing
router.post("/trigger-recurring", async (req, res) => {
  await createRecurringExpenses();
  res.status(200).send("Recurring expenses job triggered successfully.");
});

module.exports = { router, createRecurringExpenses };
