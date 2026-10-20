class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function notFoundHandler(req, res) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || err.statusCode;
  let message = err.message;

  if (!status) {
    if (
      err.name === "SequelizeUniqueConstraintError" ||
      (err.original &&
        (err.original.code === "SQLITE_CONSTRAINT" ||
          err.original.code === "23505"))
    ) {
      status = 409;
      const isRecurringConflict =
        (err.fields &&
          (Array.isArray(err.fields)
            ? err.fields.includes("recurringGroupId")
            : "recurringGroupId" in err.fields)) ||
        (err.parent &&
          err.parent.constraint ===
            "transactions_recurring_group_date_unique") ||
        (err.original &&
          String(err.original.message).includes("recurringGroupId"));

      if (isRecurringConflict) {
        message =
          "Another occurrence of this recurring series is already on that date.";
      } else {
        const fieldNames = err.fields
          ? Array.isArray(err.fields)
            ? err.fields.join(", ")
            : Object.keys(err.fields).join(", ")
          : "record";
        message = `A duplicate ${fieldNames} already exists.`;
      }
    } else {
      status = 500;
    }
  }

  const isClientErr = status >= 400 && status < 500;
  const isProd = process.env.NODE_ENV === "production";

  if (status >= 500) {
    console.error("request failed", {
      path: req.path,
      method: req.method,
      err: err.message,
      stack: isProd ? undefined : err.stack,
    });
  } else {
    console.warn("request rejected", {
      path: req.path,
      method: req.method,
      status,
      err: err.message,
    });
  }

  const safeMessage = isClientErr
    ? message || "Bad request"
    : "Internal server error";

  const body = { error: safeMessage };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
}

module.exports = { HttpError, asyncHandler, notFoundHandler, errorHandler };
