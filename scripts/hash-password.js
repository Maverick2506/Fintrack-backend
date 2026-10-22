// Usage: node scripts/hash-password.js "<your password>"
// Prints a value for the SUPER_SECRET_PASSWORD_HASH environment variable.
const { hashPassword } = require("../config/auth");

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "<your password>"');
  process.exit(1);
}

console.log(hashPassword(password));
