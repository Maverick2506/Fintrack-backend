const crypto = require("crypto");
const express = require("express");
const { sequelize, Account, Transaction } = require("../models");
const { Op } = require("sequelize");
const { toZonedTime, format } = require("date-fns-tz");
const { subDays } = require("date-fns");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, validateIdParam, schemas } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");
const { retireAccount } = require("../services/accountArchiveService");
const { groupSeries, ACTIVE_RECURRENCES } = require("./recurring");
const { getSinkingFunds } = require("../services/sinkingFundService");
const router = express.Router();
router.param("id", validateIdParam);

router.use("/savings-goals", authMiddleware);

const TIMEZONE = "America/Toronto";
const getTodayString = () =>
  format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd", {
    timeZone: TIMEZONE,
  });

// A goal can be linked to a bill: a series of expenses. Returns an error message, or null when it's fine.
const checkLinkedBill = async (recurringGroupId) => {
  if (!recurringGroupId) return null;
  const row = await Transaction.findOne({ where: { recurringGroupId } });
  if (!row) return "That bill was not found.";
  if (row.type !== "EXPENSE") return "Only a bill (an expense series) can be linked.";
  return null;
};

// "Saving for" a one-time bill (an unpaid expense row): the row gets a series id of its own, so the
// goal links to it like any bill. Returns { recurringGroupId } or { error }.
const linkOneOffBill = async (billId) => {
  const row = await Transaction.findByPk(billId);
  if (!row || row.type !== "EXPENSE") return { error: "That bill was not found." };
  if (row.isCleared) return { error: "That bill is already paid." };
  if (!row.recurringGroupId) await row.update({ recurringGroupId: crypto.randomUUID() });
  return { recurringGroupId: row.recurringGroupId };
};

// Resolves the bill a create or update links: linkedBillId (a one-time bill) wins over
// linkedRecurringGroupId (a series). Returns { linked } (undefined = unchanged) or { error }.
const resolveLinkedBill = async (body) => {
  if (body.linkedBillId) {
    const { recurringGroupId, error } = await linkOneOffBill(body.linkedBillId);
    return error ? { error } : { linked: recurringGroupId };
  }
  if (body.linkedRecurringGroupId === undefined) return { linked: undefined };
  const error = await checkLinkedBill(body.linkedRecurringGroupId);
  return error ? { error } : { linked: body.linkedRecurringGroupId || null };
};

// Sinking fund fields for the goal card, or null for a goal with no linked bill
const formatSinkingFund = (fund) =>
  fund
    ? {
        linkedBill: fund.linkedBill,
        targetAmount: fund.target,
        dueDate: fund.dueDate,
        remaining: fund.remaining,
        monthly: fund.monthly,
        firstDate: fund.dates[0] || null,
        contributions: fund.dates.length,
        ready: fund.ready,
        overdue: fund.overdue,
        monthlyTransfer: fund.monthlyTransfer,
        billInForecast: fund.billInForecast,
        saved: fund.saved,
        // A one-time bill (or an ended series) that was paid: the goal is Done
        done: Boolean(fund.done),
        paidOn: fund.paidOn || null,
      }
    : null;

router.get(
  "/savings-goals",
  asyncHandler(async (req, res) => {
    const goals = await Account.findAll({
      where: { type: "SAVINGS_GOAL", isActive: { [Op.ne]: false } },
      order: [["createdAt", "ASC"]],
    });

    const nowZoned = toZonedTime(new Date(), TIMEZONE);
    const cutoff90Days = format(subDays(nowZoned, 90), "yyyy-MM-dd", {
      timeZone: TIMEZONE,
    });
    const goalIds = goals.map((g) => g.id);

    const contributionMap = {};
    if (goalIds.length > 0) {
      const contributions = await Transaction.findAll({
        attributes: ["toAccountId", "amount"],
        where: {
          toAccountId: { [Op.in]: goalIds },
          isCleared: true,
          date: { [Op.gte]: cutoff90Days },
        },
        raw: true,
      });

      for (const c of contributions) {
        contributionMap[c.toAccountId] =
          (contributionMap[c.toAccountId] || 0) + (parseFloat(c.amount) || 0);
      }
    }

    // A running contribution series per goal (its newest recurring row), for "Recurring: $X every
    // <cadence> · End" on the goal card. A goal with several picks the latest one.
    const recurringByGoal = {};
    if (goalIds.length > 0) {
      const seriesRows = await Transaction.findAll({
        where: {
          toAccountId: { [Op.in]: goalIds },
          [Op.or]: [
            { recurrence: { [Op.in]: ACTIVE_RECURRENCES } },
            { recurringGroupId: { [Op.ne]: null } },
          ],
        },
        order: [
          ["date", "DESC"],
          ["createdAt", "DESC"],
        ],
      });
      for (const { template } of Object.values(groupSeries(seriesRows).seriesTemplates)) {
        const current = recurringByGoal[template.toAccountId];
        if (current && current.date >= template.date) continue;
        recurringByGoal[template.toAccountId] = {
          date: template.date,
          contribution: {
            recurringGroupId: template.recurringGroupId || template.id,
            title: template.title,
            type: template.type.toLowerCase(),
            amount: Math.round((parseFloat(template.amount) || 0) * 100) / 100,
            recurrence: template.recurrence,
          },
        };
      }
    }

    // Phase J: Registered Account Calculations (TFSA, RRSP, FHSA)
    const registeredGoals = goals.filter((g) => g.registeredType);
    const regContributionsMap = {};
    const regWithdrawalsMap = {};

    if (registeredGoals.length > 0) {
      const currentYear = nowZoned.getFullYear();
      for (const rg of registeredGoals) {
        const year = rg.roomYear || currentYear;
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;

        const [inflow, outflow] = await Promise.all([
          Transaction.sum("amount", {
            where: {
              toAccountId: rg.id,
              isCleared: true,
              date: { [Op.between]: [yearStart, yearEnd] },
            },
          }),
          Transaction.sum("amount", {
            where: {
              fromAccountId: rg.id,
              isCleared: true,
              date: { [Op.between]: [yearStart, yearEnd] },
            },
          }),
        ]);

        regContributionsMap[rg.id] = parseFloat(inflow) || 0;
        regWithdrawalsMap[rg.id] = parseFloat(outflow) || 0;
      }
    }

    const sinkingFunds = await getSinkingFunds(getTodayString(), null, goals);

    const formatted = goals.map((g) => {
      const isRegistered = Boolean(g.registeredType);
      const contRoom =
        g.contributionRoom !== null && g.contributionRoom !== undefined
          ? parseFloat(g.contributionRoom)
          : null;
      const contributedThisYear = isRegistered
        ? Math.round((regContributionsMap[g.id] || 0) * 100) / 100
        : null;
      const withdrawnThisYear = isRegistered
        ? Math.round((regWithdrawalsMap[g.id] || 0) * 100) / 100
        : null;
      const roomLeft =
        isRegistered && contRoom !== null
          ? Math.round((contRoom - contributedThisYear) * 100) / 100
          : null;
      const isOverContributed = roomLeft !== null && roomLeft < 0;
      const roomReturnsNextYear =
        isRegistered && g.registeredType === "TFSA" ? withdrawnThisYear : null;

      return {
        ...g.toJSON(),
        current_amount: g.initialBalance,
        goal_amount: g.targetAmount,
        target_date: g.dueDate,
        contributedLast90Days:
          Math.round((contributionMap[g.id] || 0) * 100) / 100,
        registeredType: g.registeredType || null,
        contributionRoom: contRoom,
        roomYear: g.roomYear || null,
        contributedThisYear,
        withdrawnThisYear,
        roomLeft,
        isOverContributed,
        roomReturnsNextYear,
        recurringContribution: recurringByGoal[g.id]?.contribution || null,
        sinkingFund: formatSinkingFund(sinkingFunds.get(g.id)),
      };
    });
    res.json(formatted);
  })
);

// One-time bills a goal can save for: unpaid expenses, not part of a series, due from today on
router.get(
  "/savings-goals/one-off-bills",
  asyncHandler(async (req, res) => {
    const todayStr = getTodayString();
    const rows = await Transaction.findAll({
      where: {
        type: "EXPENSE",
        isCleared: false,
        recurrence: "none",
        date: { [Op.gte]: todayStr },
        amount: { [Op.gt]: 0 },
      },
      order: [["date", "ASC"]],
      limit: 200,
    });
    // A row whose series id is shared with other rows is a series occurrence, not a one-time bill
    const groupIds = rows.map((r) => r.recurringGroupId).filter(Boolean);
    const shared = new Set();
    if (groupIds.length > 0) {
      const counts = await Transaction.findAll({
        attributes: ["recurringGroupId", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
        where: { recurringGroupId: { [Op.in]: groupIds } },
        group: ["recurringGroupId"],
        raw: true,
      });
      for (const c of counts) if (parseInt(c.n, 10) > 1) shared.add(c.recurringGroupId);
    }
    res.json(
      rows
        .filter((r) => !r.recurringGroupId || !shared.has(r.recurringGroupId))
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          title: r.title,
          amount: Math.round((parseFloat(r.amount) || 0) * 100) / 100,
          date: r.date,
          recurringGroupId: r.recurringGroupId || null,
        }))
    );
  })
);

router.post(
  "/savings-goals",
  validateBody(schemas.createSavingsGoal),
  asyncHandler(async (req, res) => {
    const startingAmount =
      req.body.current_amount !== undefined
        ? parseFloat(req.body.current_amount) || 0
        : req.body.initialBalance !== undefined
        ? parseFloat(req.body.initialBalance) || 0
        : 0;

    const targetAmount = req.body.target_amount ?? req.body.goal_amount ?? 0;

    const regType = req.body.registeredType
      ? String(req.body.registeredType).toUpperCase()
      : null;
    const contRoom =
      req.body.contributionRoom !== undefined &&
      req.body.contributionRoom !== null &&
      req.body.contributionRoom !== ""
        ? parseFloat(req.body.contributionRoom)
        : null;
    const rYear = req.body.roomYear
      ? parseInt(req.body.roomYear, 10)
      : regType
      ? new Date().getFullYear()
      : null;

    const link = await resolveLinkedBill(req.body);
    if (link.error) return res.status(400).json({ error: link.error });

    const newGoal = await Account.create({
      linkedRecurringGroupId: link.linked || null,
      name: req.body.name,
      type: "SAVINGS_GOAL",
      targetAmount: parseFloat(targetAmount),
      dueDate: req.body.target_date || req.body.dueDate || null,
      initialBalance: startingAmount,
      isActive: true,
      registeredType: regType,
      contributionRoom: contRoom,
      roomYear: rYear,
    });

    res.status(201).json({
      ...newGoal.toJSON(),
      current_amount: newGoal.initialBalance,
      goal_amount: newGoal.targetAmount,
      target_date: newGoal.dueDate,
      contributedLast90Days: 0,
      registeredType: newGoal.registeredType,
      contributionRoom: newGoal.contributionRoom !== null ? parseFloat(newGoal.contributionRoom) : null,
      roomYear: newGoal.roomYear,
      contributedThisYear: 0,
      withdrawnThisYear: 0,
      roomLeft: newGoal.contributionRoom !== null ? parseFloat(newGoal.contributionRoom) : null,
      isOverContributed: false,
      roomReturnsNextYear: newGoal.registeredType === "TFSA" ? 0 : null,
      recurringContribution: null,
      sinkingFund: formatSinkingFund((await getSinkingFunds(getTodayString(), null, [newGoal])).get(newGoal.id)),
    });
  })
);

// Archives by default. Unpaid rows and recurring series using it are ended or moved to Checking.
router.delete(
  "/savings-goals/:id",
  validateBody(schemas.retireAccount),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const goal = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!goal || goal.type !== "SAVINGS_GOAL") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Savings Goal not found" });
      }

      await retireAccount(goal, req.body, dbTx);

      await dbTx.commit();
      res.status(204).send();
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.post(
  "/savings-goals/:id/contribute",
  validateBody(schemas.paymentAmount),
  asyncHandler(async (req, res) => {
    const dbTx = await sequelize.transaction();
    try {
      const goal = await Account.findByPk(req.params.id, { transaction: dbTx });
      const [checking] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });

      if (!goal || goal.type !== "SAVINGS_GOAL") {
        await dbTx.rollback();
        return res.status(404).json({ error: "Goal not found" });
      }

      const amount = parseFloat(req.body.amount);
      // Atomic increment avoids lost updates under concurrency
      await Account.increment("initialBalance", {
        by: amount,
        where: { id: goal.id },
        transaction: dbTx,
      });
      await goal.reload({ transaction: dbTx });

      await Transaction.create(
        {
          title: `Contribution to ${goal.name}`,
          amount,
          date: getTodayString(),
          type: "TRANSFER",
          category: "Savings Transfer",
          fromAccountId: checking.id,
          toAccountId: goal.id,
          isCleared: true,
          balanceApplied: true,
        },
        { transaction: dbTx }
      );

      await dbTx.commit();
      res.json({
        ...goal.toJSON(),
        current_amount: goal.initialBalance,
        goal_amount: goal.targetAmount,
        target_date: goal.dueDate,
      });
    } catch (error) {
      await dbTx.rollback();
      throw error;
    }
  })
);

router.put(
  "/savings-goals/:id",
  validateBody(schemas.updateSavingsGoal),
  asyncHandler(async (req, res) => {
    const goal = await Account.findByPk(req.params.id);
    if (goal && goal.type === "SAVINGS_GOAL") {
      const updates = {
        name: req.body.name ?? goal.name,
      };
      if (
        req.body.target_amount !== undefined ||
        req.body.goal_amount !== undefined
      ) {
        const rawTarget = req.body.target_amount ?? req.body.goal_amount;
        if (rawTarget !== null && rawTarget !== undefined) {
          updates.targetAmount = parseFloat(rawTarget);
        } else if (rawTarget === null) {
          // Cleared: the goal follows its bill's amount (checked below once the link is known)
          updates.targetAmount = 0;
        }
      }
      if (
        req.body.target_date !== undefined ||
        req.body.dueDate !== undefined
      ) {
        updates.dueDate = req.body.target_date || req.body.dueDate || null;
      }
      if (
        req.body.current_amount !== undefined &&
        req.body.current_amount !== "" &&
        req.body.current_amount !== null
      ) {
        updates.initialBalance = parseFloat(req.body.current_amount);
      }
      if (req.body.registeredType !== undefined) {
        updates.registeredType = req.body.registeredType
          ? String(req.body.registeredType).toUpperCase()
          : null;
      }
      if (req.body.contributionRoom !== undefined) {
        updates.contributionRoom =
          req.body.contributionRoom !== null && req.body.contributionRoom !== ""
            ? parseFloat(req.body.contributionRoom)
            : null;
      }
      if (req.body.roomYear !== undefined) {
        updates.roomYear = req.body.roomYear
          ? parseInt(req.body.roomYear, 10)
          : null;
      }
      const link = await resolveLinkedBill(req.body);
      if (link.error) return res.status(400).json({ error: link.error });
      if (link.linked !== undefined) updates.linkedRecurringGroupId = link.linked;
      const linkedAfter = updates.linkedRecurringGroupId !== undefined ? updates.linkedRecurringGroupId : goal.linkedRecurringGroupId;
      if (updates.targetAmount === 0 && !linkedAfter) {
        return res.status(400).json({ error: "A goal needs a target amount unless it saves for a bill." });
      }

      await goal.update(updates);
      res.json({
        ...goal.toJSON(),
        current_amount: goal.initialBalance,
        goal_amount: goal.targetAmount,
        target_date: goal.dueDate,
        registeredType: goal.registeredType,
        contributionRoom: goal.contributionRoom !== null ? parseFloat(goal.contributionRoom) : null,
        roomYear: goal.roomYear,
        sinkingFund: formatSinkingFund((await getSinkingFunds(getTodayString(), null, [goal])).get(goal.id)),
      });
    } else {
      res.status(404).json({ error: "Savings Goal not found" });
    }
  })
);

// "Set up monthly transfer" for a sinking fund: monthly TRANSFERs from Checking to the goal for the
// sinking fund's monthly amount, on each contribution date up to the due date. Refused when the goal
// has no linked bill, nothing left to save, or already has a running or scheduled transfer.
router.post(
  "/savings-goals/:id/monthly-transfer",
  validateBody(schemas.noFields),
  asyncHandler(async (req, res) => {
    const todayStr = getTodayString();
    const dbTx = await sequelize.transaction();
    let rows;
    try {
      const goal = await Account.findByPk(req.params.id, { transaction: dbTx });
      if (!goal || goal.type !== "SAVINGS_GOAL" || goal.isActive === false) {
        await dbTx.rollback();
        return res.status(404).json({ error: "Savings Goal not found" });
      }
      const fund = (await getSinkingFunds(todayStr, dbTx, [goal])).get(goal.id);
      const refusal = !fund
        ? "Link a bill to this goal first."
        : fund.done
        ? "This bill is paid, so the goal is done."
        : fund.monthlyTransfer
        ? "This goal already has a monthly transfer."
        : !fund.monthly
        ? fund.ready
          ? "This goal already has enough saved."
          : "Set a target amount and date first."
        : null;
      if (refusal) {
        await dbTx.rollback();
        return res.status(409).json({ error: refusal });
      }
      const [checking] = await Account.findOrCreate({
        where: { name: "Primary Checking" },
        defaults: { type: "CHECKING", initialBalance: 0.0 },
        transaction: dbTx,
      });
      // One scheduled transfer per contribution date up to the due date, so the transfers stop once
      // the bill is covered. They share a group id (one "series" in the Ledger) but none recurs, so
      // the generator never adds more. The last one is what's left, so they add up to the target.
      const recurringGroupId = crypto.randomUUID();
      const count = fund.dates.length;
      const lastAmount = Math.round((fund.remaining - fund.monthly * (count - 1)) * 100) / 100;
      rows = [];
      for (const [i, date] of fund.dates.entries()) {
        const row = await Transaction.create(
          {
            title: `Contribution to ${goal.name}`,
            amount: i === count - 1 && lastAmount > 0 ? lastAmount : fund.monthly,
            date,
            type: "TRANSFER",
            category: "Savings Transfer",
            isCleared: false,
            balanceApplied: false,
            recurrence: "none",
            recurringGroupId,
            fromAccountId: checking.id,
            toAccountId: goal.id,
          },
          { transaction: dbTx }
        );
        rows.push(row);
      }
      await dbTx.commit();
    } catch (error) {
      if (!dbTx.finished) await dbTx.rollback();
      throw error;
    }
    res.status(201).json({
      recurringGroupId: rows[0].recurringGroupId,
      amount: parseFloat(rows[0].amount),
      dates: rows.map((r) => r.date),
      until: rows[rows.length - 1].date,
      count: rows.length,
    });
  })
);

module.exports = router;
