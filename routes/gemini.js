const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let genAI;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
} else {
  console.error("GEMINI_API_KEY is not set. AI features will be disabled.");
}

router.use(authMiddleware);

router.post("/financial-advice", async (req, res) => {
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });
    const prompt = `Based on the following financial data, provide a short, actionable financial tip for a user named Maverick: ${JSON.stringify(
      req.body
    )}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ advice: response.text() });
  } catch (error) {
    console.error("Gemini financial advice error:", error);
    res.status(500).json({ error: "Failed to generate financial advice." });
  }
});

router.post("/categorize-expense", async (req, res) => {
  if (!genAI) {
    return res.status(500).json({ error: "AI service is not configured." });
  }
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });
    const prompt = `Categorize the following expense into one of these categories: Essentials, Subscription, Debt, Food & Drink, Transportation, Entertainment, Shopping, Other. Expense: "${req.body.name}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ category: response.text().trim() });
  } catch (error) {
    console.error("Gemini categorization error:", error);
    res.status(500).json({ error: "Failed to categorize expense." });
  }
});

module.exports = router;
