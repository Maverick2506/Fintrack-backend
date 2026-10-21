# FinTrack Backend

Personal financial tracking API powered by Express, Sequelize (PostgreSQL in production on Render / SQLite in testing/local), and automated scheduled tasks.

## Cold-Start Pinger (Render Free Tier)

Render free instances spin down after 15 minutes of inactivity. To keep the service warm during daily waking hours while preserving free-tier monthly hours (~750 hours/month):

- **Service Provider:** [cron-job.org](https://cron-job.org) (free)
- **Target URL:** `https://fintrack-backend-rzrh.onrender.com/api/health` (HTTP GET)
- **Schedule:** Every 10 minutes between `07:00` and `23:50` America/Toronto
- **Why waking hours only:** 
  - Prevents cold starts (30–60s) when accessing the app during the day.
  - Keeps monthly active hours well within the ~750 hour free quota.
  - Fast waking: Neon database wakes in ~1s on demand.

## Scheduled Workflows & Encrypted Backups

- **Nightly Sweep, Recurrence & Backup:** Triggered automatically via GitHub Actions workflow (`.github/workflows/nightly-jobs.yml`) at `05:17 UTC` (00:17 / 01:17 Toronto time depending on daylight saving).
- **Nightly Encrypted Backup:**
  - Calls `GET /api/cron/backup` (`Authorization: Bearer $CRON_SECRET`).
  - Encrypted on the runner before leaving memory using `age` and your public key (`BACKUP_AGE_RECIPIENT`).
  - Stored in the private repository `fintrack-backups` (`BACKUPS_REPO_TOKEN` secret) and retained as an Actions artifact for 90 days.
  - The private key remains completely offline in your password manager.

### Setting Up `age` Key Pair for Backups

1. Generate a key pair locally:
   ```bash
   age-keygen -o key.txt
   ```
2. Set the public key (`age1...`) in GitHub:
   - **Repository:** `Fintrack-backend` → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab
   - **Name:** `BACKUP_AGE_RECIPIENT`
   - **Value:** `age1...` (your public key)
3. Keep `key.txt` strictly private and offline (e.g. in 1Password / Bitwarden / Keepass). Never commit it or upload to GitHub.

### Setting Up Backup Repository & Access Token

1. Create a private repository named `fintrack-backups` on GitHub with an initial `README.md` (so the initial clone succeeds).
2. Create a fine-grained personal access token (GitHub Settings → Developer Settings → Personal access tokens → Fine-grained tokens):
   - **Repository access:** Only select `fintrack-backups`
   - **Permissions:** `Contents: Read and write`
3. Save the token as a repository secret:
   - **Repository:** `Fintrack-backend` → **Settings** → **Secrets and variables** → **Actions** → **Repository secrets**
   - **Name:** `BACKUPS_REPO_TOKEN`

### Restoring from Backup

1. Decrypt the downloaded backup file:
   ```bash
   age -d -i key.txt backup.json.age > backup.json
   ```
2. Restore into local development SQLite database:
   ```bash
   node scripts/restore.js backup.json
   rm backup.json # Delete plaintext financial data after restore
   ```
   If the database already contains records, `--force` is required to overwrite:
   ```bash
   node scripts/restore.js backup.json --force
   ```
3. To restore to remote PostgreSQL (disaster recovery only):
   ```bash
   USE_PRODUCTION_DB=true DATABASE_URL="<connection-string>" node scripts/restore.js backup.json --force --production
   rm backup.json
   ```
   *(Note: The `--production` flag is strictly required when targeting a remote production database to prevent accidental data erasure).*

## Continuous Integration & Testing

- Automated GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs on every push and pull request to `main`.
- Tests run against an isolated local SQLite test database (`test-database.sqlite`), strictly isolated from production (`isProductionDb` guard) and separated from development data (`local-database.sqlite`).
- Run tests locally:
  Start the server in test mode with dev bypass enabled, then run the test runner:
  ```bash
  # Terminal 1 (macOS/Linux)
  NODE_ENV=test ALLOW_DEV_BYPASS=true npm start

  # Terminal 1 (Windows PowerShell)
  $env:NODE_ENV="test"; $env:ALLOW_DEV_BYPASS="true"; npm start

  # Terminal 2
  npm test
  ```
  *(Note: Starting the server with `NODE_ENV=test` ensures tests run against `test-database.sqlite`, keeping your `local-database.sqlite` development data completely intact. In PowerShell, `$env:` variables persist for the remainder of that terminal session, so use a separate terminal for normal development).*
