# BrossefTracker

BrossefTracker is a private, single-user Canadian personal-finance PWA designed for a home-network Docker server managed through Portainer.

## Included in the first working version

- Net-worth-first dashboard with assets, liabilities, portfolio value, bills, goals, and recent activity
- Biweekly budgeting anchored to July 23, 2026, using adjustable Needs / Wants / Savings percentages (default 50 / 30 / 20)
- Debt inside Needs, with switchable avalanche and snowball prioritization
- Investing and big purchases inside Savings, including target dates and suggested weekly pacing
- PDF, XLSX, CSV, and TSV uploads that always enter a review queue before transactions are saved
- Learned merchant-category rules when **Remember** is selected during approval
- Accounts for chequing, savings, credit, TFSA, TFSA Managed, RRSP Managed, LIRA, FHSA, taxable investments, mortgages, loans, and other assets or liabilities
- Manual or XLSX/CSV/TSV holdings entry with editable shares and average purchase prices after import
- Separate TFSA, TFSA Managed, RRSP Managed, and LIRA portfolio analysis sections
- TSX, NASDAQ, and NYSE symbol support; delayed CAD/USD quotes; CAD-converted totals; transparent buy/hold/sell scores; and S&P/TSX plus S&P 500 benchmark context
- PWA installation, cached offline dashboard access, offline record queueing, and browser notifications
- Persistent local JSON data stored atomically in a Docker volume

## Important boundaries

The portfolio report is decision support, not a prediction or automated trading system. Scores use price trend, six-month momentum, and position concentration. They do not include every material fact, cannot guarantee higher returns, and should be checked against official filings and advice from a registered Canadian adviser.

Market quotes come from a delayed public endpoint and may be unavailable or inaccurate. Choose TSX to append `.TO` to plain Canadian symbols, or choose NASDAQ/NYSE to leave U.S. symbols such as `QQQ` unchanged. U.S. prices display in USD and are converted to CAD for net-worth totals using the delayed USD/CAD quote. Official registered-account room must still be verified against CRA records—the app does not file taxes.

PDF statements vary substantially. The importer recognizes common rows containing a date, description, and amount. Scanned-image PDFs need OCR and may produce no rows. Excel/CSV imports work best with headers such as Date, Description, Amount, Debit, or Credit. Legacy `.xls` files should be saved as `.xlsx` first. Every result must be reviewed.

Canadian registered-account wording was checked against the CRA guidance for [TFSA withdrawals](https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/tax-free-savings-account/withdraw.html), [RRSP withdrawals](https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/rrsps-related-plans/making-withdrawals.html), and [FHSAs](https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/first-home-savings-account.html). Rules change; verify the current pages and your CRA records before acting.

## Run locally

Requires Node.js 20 or newer and pnpm.

```text
pnpm install
pnpm start
```

Open `http://localhost:3000`. Data is written to `./data/finance.json` during local development.

## GitHub and Portainer deployment

1. Create a GitHub repository and push this project to its `main` branch.
2. In Portainer's stack environment variables, set `GITHUB_OWNER` to the repository owner's lowercase GitHub username or organization. For local Compose, copy `.env.example` to `.env` and update it.
3. GitHub Actions builds and publishes `ghcr.io/<owner>/brossef-tracker:latest` after each push to `main`.
4. If the repository/package is private, create a GitHub classic personal access token with `read:packages`. In Portainer, add `ghcr.io` as a registry using your GitHub username and that token.
5. In Portainer, create a **Stack** from the Git repository and point it to `compose.yaml`, or paste the Compose file into the editor.
6. Enable Portainer's Git polling/webhook or image update workflow if you want automatic deployments after a new image is published.
7. Deploy the stack and open `http://<home-server-ip>:3000` from the home network.

The named volume `brossef-tracker-data` contains the only persistent application file. Include that volume in the external backup process. Do not expose the app to the public internet without adding authentication and HTTPS.

## Daily market update

The server checks every 30 minutes and refreshes once per day after the configured local hour (6:00 PM by default) when holdings exist. It must have outbound internet access. A refresh can also be started from the Portfolio screen.

## Health check

Portainer and Docker can monitor `GET /api/health`. A healthy response looks like:

```json
{"status":"ok","time":"2026-07-20T12:00:00.000Z"}
```
