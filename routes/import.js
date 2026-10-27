const express = require("express");
const multer = require("multer");
const { Op } = require("sequelize");
const { Transaction, Account } = require("../models");
const authMiddleware = require("../middleware/authMiddleware");
const { validateBody, schemas } = require("../middleware/validate");
const { asyncHandler, HttpError } = require("../middleware/errorHandler");
const {
  CsvError,
  parseCsv,
  suggestMapping,
  columnNames,
  applyMapping,
  withOccurrences,
} = require("../utils/csvImport");
const {
  listImportAccounts,
  getImportAccount,
  getSavedMapping,
  buildPreview,
  commitImport,
} = require("../services/importService");

const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Browsers label CSVs differently (Windows often says application/vnd.ms-excel); the name must end in .csv
const CSV_MIME_TYPES = new Set([
  "text/csv",
  "text/plain",
  "application/csv",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!/\.csv$/i.test(file.originalname || "") || !CSV_MIME_TYPES.has(file.mimetype || "")) {
      return cb(new HttpError(400, "Upload a .csv file exported from your bank."));
    }
    cb(null, true);
  },
});

// Multer's own errors become 400s (413 for a file over 2 MB) instead of a 500
const uploadCsv = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(new HttpError(413, "The file is over 2 MB. Export a shorter date range."));
      }
      return next(new HttpError(400, "Upload one .csv file in the 'file' field."));
    }
    next(err);
  });

const router = express.Router();
router.use(authMiddleware);

// Checking and active cards, each saying whether it has a saved column mapping
router.get(
  "/accounts",
  asyncHandler(async (req, res) => {
    res.json(await listImportAccounts());
  })
);

// Reads the file and marks each row match / duplicate / new. Saves nothing.
// mapping is optional: without it the account's saved mapping is used, else a guess from the file.
router.post(
  "/preview",
  uploadCsv,
  validateBody(schemas.importPreview),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "Upload a .csv file exported from your bank.");
    const account = await getImportAccount(req.body.accountId);
    let rows;
    try {
      rows = parseCsv(req.file.buffer.toString("utf8"));
    } catch (err) {
      if (err instanceof CsvError) throw new HttpError(400, err.message);
      throw err;
    }
    if (rows.length === 0) throw new HttpError(400, "The file is empty.");

    const savedMapping = await getSavedMapping(account.id);
    const suggestedMapping = suggestMapping(rows);
    let mapping = req.body.mapping || savedMapping || suggestedMapping;
    let mappingSource = req.body.mapping ? "request" : savedMapping ? "saved" : "suggested";
    let mapped;
    try {
      try {
        mapped = applyMapping(rows, mapping);
      } catch (err) {
        // The bank changed its export (or this is another kind of file): when the saved columns read
        // nothing but the guess does, use the guess and say the saved ones didn't fit
        if (!(err instanceof CsvError) || mappingSource !== "saved") throw err;
        mapped = applyMapping(rows, suggestedMapping);
        mapping = suggestedMapping;
        mappingSource = "savedDidNotFit";
      }
    } catch (err) {
      if (err instanceof CsvError) {
        throw new HttpError(400, err.message, {
          columns: columnNames(rows, mapping.hasHeader),
          sampleRows: rows.slice(0, 6),
          suggestedMapping,
        });
      }
      throw err;
    }
    const preview = await buildPreview(account, withOccurrences(mapped.rows));
    res.json({
      account: { id: account.id, name: account.name, type: account.type },
      columns: columnNames(rows, mapping.hasHeader),
      sampleRows: rows.slice(0, 6),
      mapping,
      mappingSource,
      suggestedMapping,
      rows: preview.rows,
      invalid: mapped.invalid,
      counts: { ...preview.counts, invalid: mapped.invalid.length },
      anchorDate: preview.anchorDate,
      balanceNow: preview.balanceNow,
      balanceAfter: preview.balanceAfter,
    });
  })
);

// Applies the preview in one transaction and saves the mapping for this account
router.post(
  "/commit",
  validateBody(schemas.importCommit),
  asyncHandler(async (req, res) => {
    res.json(await commitImport(req.body));
  })
);

// The account's saved mapping, or null
router.get(
  "/mapping/:accountId",
  asyncHandler(async (req, res) => {
    const account = await getImportAccount(req.params.accountId);
    res.json({ mapping: await getSavedMapping(account.id) });
  })
);

// "Review new" inbox: imported rows not yet confirmed, newest first
router.get(
  "/review",
  asyncHandler(async (req, res) => {
    const rows = await Transaction.findAll({
      where: { needsReview: true },
      include: [
        { model: Account, as: "fromAccount" },
        { model: Account, as: "toAccount" },
      ],
      order: [
        ["date", "DESC"],
        ["createdAt", "DESC"],
      ],
    });
    res.json(
      rows.map((t) => ({
        id: t.id,
        type: t.type.toLowerCase(),
        name: t.title,
        amount: parseFloat(t.amount),
        date: t.date,
        category: t.category,
        is_paid: t.isCleared,
        creditCardId: t.fromAccount && t.fromAccount.type === "CREDIT_CARD" ? t.fromAccount.id : null,
        targetAccountId: t.toAccountId || null,
        fromAccount: t.fromAccount ? t.fromAccount.name : null,
        toAccount: t.toAccount ? t.toAccount.name : null,
        fromAccountType: t.fromAccount ? t.fromAccount.type : null,
        toAccountType: t.toAccount ? t.toAccount.type : null,
      }))
    );
  })
);

// Confirms reviewed rows: they leave the inbox and stay in the Ledger as they are
router.post(
  "/review/confirm",
  validateBody(schemas.confirmReview),
  asyncHandler(async (req, res) => {
    const [confirmed] = await Transaction.update(
      { needsReview: false },
      { where: { id: { [Op.in]: req.body.ids }, needsReview: true } }
    );
    res.json({ confirmed });
  })
);

module.exports = router;
