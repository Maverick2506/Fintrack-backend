// Idempotent create support (Phase L): a client sends a clientRef with a new
// expense or income so a retry returns the row it already saved.

const CLIENT_REF_INDEX = "transactions_client_ref_unique";

// True when a write failed because another request already saved this clientRef.
// Covers Postgres (fields object, constraint name) and SQLite (fields array).
function isClientRefConflict(err) {
  if (!err) return false;
  const isUniqueViolation =
    err.name === "SequelizeUniqueConstraintError" ||
    (err.original && err.original.code === "23505");
  if (!isUniqueViolation) return false;

  const constraint =
    (err.parent && err.parent.constraint) ||
    (err.original && err.original.constraint);
  if (constraint === CLIENT_REF_INDEX) return true;

  if (err.fields) {
    return Array.isArray(err.fields)
      ? err.fields.includes("clientRef")
      : "clientRef" in err.fields;
  }
  return false;
}

module.exports = { isClientRefConflict };
