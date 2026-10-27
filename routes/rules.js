const express = require("express");
const { Op } = require("sequelize");
const { Rule, Account } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler, HttpError } = require("../middleware/errorHandler");
const { loadRules } = require("../services/ruleService");

const router = express.Router();
router.param("id", validateIdParam);
router.use(authMiddleware);

// A rule's account must be checking or an active card: it's the account a purchase is charged to
const assertRuleAccount = async (accountId) => {
  if (!accountId) return;
  const account = await Account.findOne({
    where: { id: accountId, type: { [Op.in]: ["CHECKING", "CREDIT_CARD"] }, isActive: { [Op.ne]: false } },
  });
  if (!account) throw new HttpError(400, "A rule's account must be checking or an active credit card.");
};

const toJson = (rule, accounts) => ({
  id: rule.id,
  match: rule.match,
  category: rule.category,
  accountId: rule.accountId,
  accountName: rule.accountId ? accounts.get(rule.accountId)?.name || null : null,
  priority: rule.priority,
});

const accountNames = async (rules) => {
  const ids = [...new Set(rules.map((r) => r.accountId).filter(Boolean))];
  const accounts = ids.length ? await Account.findAll({ where: { id: { [Op.in]: ids } } }) : [];
  return new Map(accounts.map((a) => [a.id, a]));
};

// Rules in the order they apply
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const rules = await loadRules();
    const accounts = await accountNames(rules);
    res.json(rules.map((r) => toJson(r, accounts)));
  })
);

router.post(
  "/",
  validateBody(schemas.createRule),
  asyncHandler(async (req, res) => {
    await assertRuleAccount(req.body.accountId);
    const rule = await Rule.create({
      match: req.body.match,
      category: req.body.category || null,
      accountId: req.body.accountId || null,
      priority: req.body.priority,
    });
    res.status(201).json(toJson(rule, await accountNames([rule])));
  })
);

router.put(
  "/:id",
  validateBody(schemas.updateRule),
  asyncHandler(async (req, res) => {
    const rule = await Rule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    await assertRuleAccount(req.body.accountId);
    const next = {
      match: req.body.match ?? rule.match,
      category: req.body.category !== undefined ? req.body.category : rule.category,
      accountId: req.body.accountId !== undefined ? req.body.accountId : rule.accountId,
      priority: req.body.priority ?? rule.priority,
    };
    if (!next.category && !next.accountId) {
      throw new HttpError(400, "A rule needs a category, an account, or both");
    }
    await rule.update(next);
    res.json(toJson(rule, await accountNames([rule])));
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const deleted = await Rule.destroy({ where: { id: req.params.id } });
    if (!deleted) return res.status(404).json({ error: "Rule not found" });
    res.status(204).send();
  })
);

module.exports = router;
