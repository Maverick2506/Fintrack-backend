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

## Scheduled Workflows

- **Nightly Sweep & Recurrence:** Triggered automatically via GitHub Actions workflow (`.github/workflows/nightly-jobs.yml`) at `05:17 UTC` (00:17 / 01:17 Toronto time depending on daylight saving).

## Continuous Integration & Testing

- Automated GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs on every push and pull request to `main`.
- Tests run against an isolated local SQLite test database, strictly isolated from production (`isProductionDb` guard).
- Run tests locally:
  ```bash
  npm test
  ```
