const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  const match = envContent.match(/DATABASE_URL=(.*)/);
  if (match && match[1]) {
    process.env.DATABASE_URL = match[1].trim();
  }
}
const { Account } = require("./models");
Account.findAll().then(res => { console.log(JSON.stringify(res, null, 2)); process.exit(0); });
