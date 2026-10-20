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

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const optionalNumber = (n) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), n.optional());

const optionalDate = z.preprocess(
  (v) => (v === "" ? null : v),
  z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").nullable().optional()
);

const schemas = {
  createExpense: z.object({
    name: z.string().trim().min(1, "Name is required").max(255),
    amount: z.coerce.number().positive("Amount must be greater than 0"),
    due_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    payment_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    category: z.string().trim().max(100).optional(),
    is_paid: z.boolean().optional(),
    creditCardId: z.union([z.string(), z.number()]).nullable().optional(),
    targetAccountId: z.union([z.string(), z.number()]).nullable().optional(),
    toAccountId: z.union([z.string(), z.number()]).nullable().optional(),
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
  }),

  updateExpense: z.object({
    name: z.string().trim().min(1).max(255).optional(),
    amount: z.coerce.number().positive("Amount must be greater than 0").optional(),
    due_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    payment_date: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    category: z.string().trim().max(100).optional(),
    is_paid: z.boolean().optional(),
    creditCardId: z.union([z.string(), z.number()]).nullable().optional(),
    targetAccountId: z.union([z.string(), z.number()]).nullable().optional(),
    toAccountId: z.union([z.string(), z.number()]).nullable().optional(),
    recurrence: z
      .enum(["none", "weekly", "bi-weekly", "monthly", "yearly"])
      .optional(),
    isTaxExclusive: z.boolean().optional(),
    taxRate: z.coerce.number().nonnegative().max(100).nullable().optional(),
    baseAmount: z.coerce.number().nonnegative().nullable().optional(),
    taxApplied: z.boolean().optional(),
    recurringGroupId: z.string().uuid().nullable().optional(),
  }),

  createPaycheque: z.object({
    name: z.string().trim().min(1, "Name is required").max(255),
    amount: z.coerce.number().positive("Amount must be greater than 0"),
    payment_date: z.string().regex(dateRegex, "Payment date must be in YYYY-MM-DD format"),
    recurrence: z
      .enum(["none", "weekly", "bi-weekly", "monthly", "yearly"])
      .optional()
      .default("none"),
  }),

  paymentAmount: z.object({
    amount: z.coerce.number().positive("Payment amount must be greater than 0"),
  }),

  createCreditCard: z.object({
    name: z.string().trim().min(1, "Card name is required").max(255),
    creditLimit: z.coerce.number().nonnegative("Credit limit cannot be negative"),
    currentBalance: z.coerce.number().optional().default(0),
    initialBalance: z.coerce.number().optional(),
    dueDate: z.union([z.string(), z.number()]).nullable().optional(),
  }),

  updateCreditCard: z.object({
    name: z.string().trim().min(1).max(255).optional(),
    creditLimit: z.coerce.number().nonnegative().optional(),
    currentBalance: z.coerce.number().optional(),
    initialBalance: z.coerce.number().optional(),
    dueDate: z.union([z.string(), z.number()]).nullable().optional(),
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
  }),

  updateChecking: z.object({
    balance: z.coerce.number(),
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
};

module.exports = {
  validateBody,
  schemas,
};
