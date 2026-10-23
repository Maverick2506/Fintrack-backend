const express = require("express");
const { Account } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { validateIdParam } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { getDeleteImpact } = require("../services/accountArchiveService");
const router = express.Router();
router.param("id", validateIdParam);

router.use("/accounts", authMiddleware);

// What archiving or deleting a card, debt or savings goal would affect, for the confirm dialog
router.get(
  "/accounts/:id/delete-impact",
  asyncHandler(async (req, res) => {
    const account = await Account.findByPk(req.params.id);
    if (!account || account.type === "CHECKING") {
      return res.status(404).json({ error: "Account not found" });
    }
    res.json(await getDeleteImpact(account));
  })
);

module.exports = router;
