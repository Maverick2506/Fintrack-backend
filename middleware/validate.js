const { z } = require("zod");

const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const details = (result.error.issues || []).map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return res.status(400).json({
      error: "Validation error: invalid request payload.",
      details,
    });
  }
  req.body = result.data;
  next();
};

const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const details = (result.error.issues || []).map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return res.status(400).json({
      error: "Validation error: invalid query parameters.",
      details,
    });
  }
  // Express 5 exposes req.query as a getter, so keep parsed values on their own property
  req.validatedQuery = result.data;
  next();
};

// Rejects non-UUID :id params with 400 instead of a database "invalid input syntax for uuid" 500 (B14)
const validateIdParam = (req, res, next, id) => {
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: "Invalid id: expected a UUID." });
  }
  next();
};

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

// Account references: a UUID, or empty/null to clear (B14)
const optionalAccountId = z.preprocess(
  (v) => (v === "" ? null : v),
  z.string().uuid("Invalid account id").nullable().optional()
);

const optionalNumber = (n) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), n.optional());

const optionalDate = z.preprocess(
  (v) => (v === "" ? null : v),
  z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").nullable().optional()
);

// Card statement day: 1-31, or empty/null to clear
const optionalStatementDay = z.preprocess(
  (v) => (v === "" ? null : v),
  z.coerce.number().int().min(1, "Statement day is 1-31").max(31, "Statement day is 1-31").nullable().optional()
);

// A goal's linked bill: a series id, or empty/null to unlink
const optionalSeriesId = z.preprocess(
  (v) => (v === "" ? null : v),
  z.string().uuid("Invalid bill").nullable().optional()
);

const { EXPENSE_CATEGORIES } = require("../constants/categories");
const { DATE_FORMATS, MAX_IMPORT_ROWS } = require("../utils/csvImport");

const ruleCategory = z.preprocess(
  (v) => (v === "" ? null : v),
  z.enum(EXPENSE_CATEGORIES, { message: "Pick one of the expense categories" }).nullable().optional()
);

const columnIndex = z.coerce.number().int().min(0).max(49);

// How the columns of a bank CSV map to a transaction. Either one signed amount column (outflow says
// whether money out is negative, the usual, or positive) or separate debit and credit columns.
const importMapping = z
  .object({
    hasHeader: z.boolean(),
    date: columnIndex,
    description: z.preprocess(
      (v) => (Array.isArray(v) ? v : [v]),
      z.array(columnIndex).min(1).max(3)
    ),
    amount: columnIndex.nullable().optional(),
    debit: columnIndex.nullable().optional(),
    credit: columnIndex.nullable().optional(),
    dateFormat: z.enum(DATE_FORMATS),
    outflow: z.enum(["negative", "positive"]).optional().default("negative"),
  })
  .refine(
    (m) =>
      (m.amount !== undefined && m.amount !== null) ||
      (m.debit !== undefined && m.debit !== null && m.credit !== undefined && m.credit !== null),
    { message: "Map an amount column, or both a debit and a credit column", path: ["amount"] }
  );

const schemas = {
  createExpense: z.object({
    name: z.string().trim().min(1, "Name is required").max(255),
    amount: z.coerce.number().positive("Amount must be greater than 0"),
    due_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    payment_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    category: z.string().trim().max(100).optional(),
    is_paid: z.boolean().optional(),
    creditCardId: optionalAccountId,
    targetAccountId: optionalAccountId,
    toAccountId: optionalAccountId,
    recurrence: z
      .enum(["none", "weekly", "bi-weekly", "monthly", "yearly"])
      .optional()
      .default("none"),
    isTaxExclusive: z.boolean().optional().default(false),
    taxRate: z.coerce.number().nonnegative().max(100).nullable().optional(),
    baseAmount: z.coerce.number().nonnegative().nullable().optional(),
    taxApplied: z.boolean().optional().default(false),
    recurringGroupId: z.string().uuid().nullable().optional(),
    applyToBalance: z.boolean().optional(),
    clientRef: z.string().uuid().nullable().optional(),
  }),

  updateExpense: z.object({
    name: z.string().trim().min(1).max(255).optional(),
    amount: z.coerce.number().positive("Amount must be greater than 0").optional(),
    due_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    payment_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    category: z.string().trim().max(100).optional(),
    is_paid: z.boolean().optional(),
    creditCardId: optionalAccountId,
    targetAccountId: optionalAccountId,
    toAccountId: optionalAccountId,
    recurrence: z
      .enum(["none", "weekly", "bi-weekly", "monthly", "yearly"])
      .optional(),
    isTaxExclusive: z.boolean().optional(),
    taxRate: z.coerce.number().nonnegative().max(100).nullable().optional(),
    baseAmount: z.coerce.number().nonnegative().nullable().optional(),
    taxApplied: z.boolean().optional(),
    recurringGroupId: z.string().uuid().nullable().optional(),
    clientRef: z.string().uuid().nullable().optional(),
  }),

  createPaycheque: z.object({
    name: z.string().trim().min(1, "Name is required").max(255),
    amount: z.coerce.number().positive("Amount must be greater than 0"),
    payment_date: z.string().regex(dateRegex, "Payment date must be in YYYY-MM-DD format"),
    recurrence: z
      .enum(["none", "weekly", "bi-weekly", "monthly", "yearly"])
      .optional()
      .default("none"),
    clientRef: z.string().uuid().nullable().optional(),
  }),

  paymentAmount: z.object({
    amount: z.coerce.number().positive("Payment amount must be greater than 0"),
  }),

  createCreditCard: z.object({
    name: z.string().trim().min(1, "Card name is required").max(255),
    creditLimit: z.coerce.number().nonnegative("Credit limit cannot be negative"),
    currentBalance: z.coerce.number().optional().default(0),
    initialBalance: z.coerce.number().optional(),
    dueDate: optionalDate,
    statementDay: optionalStatementDay,
  }),

  updateCreditCard: z.object({
    name: z.string().trim().min(1).max(255).optional(),
    creditLimit: z.coerce.number().nonnegative().optional(),
    currentBalance: z.coerce.number().optional(),
    initialBalance: z.coerce.number().optional(),
    dueDate: optionalDate,
    statementDay: optionalStatementDay,
  }),

  createDebt: z.object({
    name: z.string().trim().min(1, "Debt name is required").max(255),
    total_amount: z.coerce.number().positive("Total debt amount must be greater than 0"),
    monthly_payment: optionalNumber(z.coerce.number().nonnegative()),
    auto_pay: z.boolean().optional().default(false),
    next_due_date: optionalDate,
    payment_frequency: z
      .enum(["weekly", "bi-weekly", "monthly", "yearly"])
      .optional()
      .default("monthly"),
    interest_rate: z
      .union([z.coerce.number().nonnegative(), z.literal("")])
      .nullable()
      .optional(),
    interestRate: z
      .union([z.coerce.number().nonnegative(), z.literal("")])
      .nullable()
      .optional(),
  }),

  updateDebt: z.object({
    name: z.string().trim().min(1).max(255).optional(),
    total_amount: optionalNumber(z.coerce.number().positive()),
    total_remaining: optionalNumber(z.coerce.number()),
    monthly_payment: optionalNumber(z.coerce.number().nonnegative()).nullable(),
    auto_pay: z.boolean().optional(),
    next_due_date: optionalDate,
    payment_frequency: z
      .enum(["weekly", "bi-weekly", "monthly", "yearly"])
      .optional(),
    interest_rate: z
      .union([z.coerce.number().nonnegative(), z.literal("")])
      .nullable()
      .optional(),
    interestRate: z
      .union([z.coerce.number().nonnegative(), z.literal("")])
      .nullable()
      .optional(),
  }),

  createSavingsGoal: z.object({
    name: z.string().trim().min(1, "Goal name is required").max(255),
    target_amount: optionalNumber(z.coerce.number().positive()),
    goal_amount: optionalNumber(z.coerce.number().positive()),
    current_amount: optionalNumber(z.coerce.number().nonnegative()).default(0),
    initialBalance: optionalNumber(z.coerce.number().nonnegative()),
    target_date: optionalDate,
    dueDate: optionalDate,
    registeredType: z
      .preprocess(
        (v) => (v === "" || v === null ? null : typeof v === "string" ? v.toUpperCase() : v),
        z.enum(["TFSA", "RRSP", "FHSA"]).nullable().optional()
      ),
    contributionRoom: optionalNumber(z.coerce.number().nonnegative()),
    roomYear: optionalNumber(z.coerce.number().int().min(2000).max(2100)),
    linkedRecurringGroupId: optionalSeriesId,
  }),

  updateSavingsGoal: z.object({
    name: z.string().trim().min(1).max(255).optional(),
    target_amount: optionalNumber(z.coerce.number().positive()),
    goal_amount: optionalNumber(z.coerce.number().positive()),
    current_amount: optionalNumber(z.coerce.number().nonnegative()),
    initialBalance: optionalNumber(z.coerce.number().nonnegative()),
    target_date: optionalDate,
    dueDate: optionalDate,
    registeredType: z
      .preprocess(
        (v) => (v === "" || v === null ? null : typeof v === "string" ? v.toUpperCase() : v),
        z.enum(["TFSA", "RRSP", "FHSA"]).nullable().optional()
      ),
    contributionRoom: optionalNumber(z.coerce.number().nonnegative()),
    roomYear: optionalNumber(z.coerce.number().int().min(2000).max(2100)),
    linkedRecurringGroupId: optionalSeriesId,
  }),

  // DELETE /credit-cards|debts|savings-goals/:id. An empty body archives and ends the account's series.
  retireAccount: z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
      mode: z.enum(["archive", "delete"]).optional().default("archive"),
      series: z.enum(["end", "moveToChecking"]).optional().default("end"),
      moveBalanceToChecking: z.boolean().optional().default(false),
    })
  ),

  // POST /accounts/:id/final-payment takes no fields
  finalPayment: z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}).strict()
  ),

  adjustToZero: z.object({
    reason: z.enum(["written_off", "closed_by_bank", "spent"]),
  }),

  // POST /accounts/:id/reconcile
  reconcile: z.object({
    actualBalance: z.coerce.number().finite(),
    date: optionalDate,
    reason: z.enum(["interest", "adjustment"]).optional().default("adjustment"),
  }),

  setAiDailyCap: z.object({
    cap: z.coerce.number().int("The limit must be a whole number").min(0).max(10000),
  }),

  setDebtInterest: z.object({
    enabled: z.union([
      z.boolean(),
      z.enum(["true", "false"]).transform((v) => v === "true"),
    ]),
  }),

  updateChecking: z.object({
    balance: z.coerce.number(),
  }),

  setForecastEstimateIncome: z.object({
    enabled: z.union([
      z.boolean(),
      z.enum(["true", "false"]).transform((v) => v === "true"),
    ]),
  }),

  setForecastBuffer: z.object({
    buffer: z.coerce.number().min(0, "Buffer must be non-negative"),
  }),

  setBudget: z
    .object({
      monthlyLimit: z.coerce.number().positive("Monthly limit must be greater than 0").optional(),
      limit: z.coerce.number().positive("Monthly limit must be greater than 0").optional(),
      rollover: z.boolean().optional().default(false),
    })
    .refine((data) => data.monthlyLimit !== undefined || data.limit !== undefined, {
      message: "Monthly limit is required and must be greater than 0",
      path: ["monthlyLimit"],
    }),

  categorizeExpense: z.object({
    name: z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters"),
  }),

  chatAdvisor: z.object({
    message: z.string().trim().min(1, "Message is required").max(2000, "Message is too long (max 2000 characters)"),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "model"]),
          text: z.string().optional(),
          content: z.string().optional(),
        })
      )
      .default([])
      .transform((h) =>
        h
          .slice(-8)
          .map((m) => ({ role: m.role, text: (m.text ?? m.content ?? "").trim().slice(0, 4000) }))
          .filter((m) => m.text)
      ),
  }),

  bulkDelete: z.object({
    ids: z.array(z.string().uuid("Invalid transaction id")).min(1, "No transaction IDs provided.").max(500),
  }),

  restoreExpenses: z.object({
    ids: z.array(z.string().uuid("Invalid transaction id")).min(1, "No transaction IDs provided.").max(500),
  }),

  // POST /recurring/:recurringGroupId/end
  endSeries: z
    .object({ dryRun: z.boolean().optional() })
    .optional()
    .default({}),

  // POST /savings-goals/:id/monthly-transfer and the subscription suggestion actions take no fields
  noFields: z.object({}).strict().optional().default({}),

  // Accept a "Make this a subscription?" suggestion, optionally with the series' name
  acceptSuggestion: z
    .object({ title: z.string().trim().min(1, "Name the subscription").max(255).optional() })
    .strict()
    .optional()
    .default({}),

  // PUT /expenses/:id?dryRun=1 previews the change (e.g. ending a series) and saves nothing
  dryRunQuery: z.object({
    dryRun: z.enum(["0", "1", "true", "false"]).optional(),
  }),

  monthQuery: z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
    sortBy: z.string().optional(),
    sortOrder: z.string().optional(),
  }),

  createRule: z
    .object({
      match: z.string().trim().min(1, "Enter the text to match").max(100),
      category: ruleCategory,
      accountId: optionalAccountId,
      priority: z.coerce.number().int().min(0).max(10000).optional().default(100),
    })
    .refine((r) => r.category || r.accountId, {
      message: "A rule needs a category, an account, or both",
      path: ["category"],
    }),

  updateRule: z.object({
    match: z.string().trim().min(1, "Enter the text to match").max(100).optional(),
    category: ruleCategory,
    accountId: optionalAccountId,
    priority: z.coerce.number().int().min(0).max(10000).optional(),
  }),

  // POST /import/preview sends these as multipart fields, so mapping arrives as a JSON string
  importPreview: z.object({
    accountId: z.string().uuid("Pick an account"),
    mapping: z
      .preprocess((v) => {
        if (v === undefined || v === "") return undefined;
        if (typeof v !== "string") return v;
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }, importMapping.optional()),
  }),

  importCommit: z.object({
    accountId: z.string().uuid("Pick an account"),
    mapping: importMapping.optional(),
    rows: z
      .array(
        z.object({
          date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)"),
          description: z.string().trim().min(1).max(255),
          amount: z.coerce.number().positive().max(10000000),
          direction: z.enum(["out", "in"]),
          occurrence: z.coerce.number().int().min(1).max(MAX_IMPORT_ROWS).optional().default(1),
          category: z.string().trim().max(100).nullable().optional(),
          matchId: z.string().uuid().nullable().optional(),
          // "Same" on a possible match: the app row this bank row is
          linkId: z.string().uuid().nullable().optional(),
          skip: z.boolean().optional().default(false),
        })
      )
      .min(1, "Nothing to import")
      .max(MAX_IMPORT_ROWS),
  }),

  confirmReview: z.object({
    ids: z.array(z.string().uuid("Invalid transaction id")).min(1, "No transaction IDs provided.").max(MAX_IMPORT_ROWS),
  }),

  financialAdvice: z.object({
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    force: z.boolean().optional(),
  }).passthrough().optional().default({}),
};

module.exports = {
  validateBody,
  validateQuery,
  validateIdParam,
  schemas,
};
