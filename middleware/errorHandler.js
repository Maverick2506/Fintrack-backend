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
  const status = err.status || err.statusCode || 500;
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
    ? err.message || "Bad request"
    : "Internal server error";

  const body = { error: safeMessage };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
}

module.exports = { HttpError, asyncHandler, notFoundHandler, errorHandler };
