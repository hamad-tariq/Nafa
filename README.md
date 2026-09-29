# Fund Board

A FastAPI app that reads the Al Meezan "Fund Prices and Performance" emails from a Gmail inbox, keeps every
price in a database, calculates returns, risk and costs, and serves a dashboard at `/`.

The public site is one page. It carries all prices and history in the HTML, so there's no data API to call.
It never says where the prices come from, and there's no Swagger, ReDoc or OpenAPI schema.

| Path | Who can use it |
|---|---|
| `/` and `/assets/*` | Everyone: the dashboard |
| `GET /api/status`, `POST /api/refresh` | Only the dashboard page itself: same-site requests carrying the signed token the page was served with (valid 6 hours). Everything else gets 404. |
| `GET /api/refresh` | Vercel Cron, with `Authorization: Bearer <CRON_SECRET>` |
| `POST /api/ingest` | The owner, with the same header (see below) |

Anything a browser shows can be copied, so the lock keeps other sites and casual scripts out of the API, not
someone determined to scrape the page. Keep the Git repo private: the code has to say where the prices come from.

## Deploy on Vercel

1. Push this folder to a Git repo and import it in Vercel. It's detected as FastAPI (`app.py`).
2. **Storage → Create → Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL`.
3. Add environment variables:
   - `MI_EMAIL`: your Gmail address
   - `MI_APP_PASSWORD`: a Gmail app password (turn on 2-Step Verification, then create one at https://myaccount.google.com/apppasswords)
   - `CRON_SECRET`: any long random string (required). It signs the page's API tokens and authorizes the cron and uploads.
   - Optional: `ANTHROPIC_API_KEY` for image-only emails and screenshots. `MI_IMAP_FOLDER` if a filter archives the
     emails (for example `[Gmail]/All Mail`).
4. Deploy and open the site. The first visit imports every price email already in the inbox (about 3 minutes
   for 130 emails) and shows progress in the header.

Keeping it current:
- The dashboard looks for new prices by itself when the last check is over 30 minutes old, and picks up new
  prices while it's open. **Update prices** in the header checks now. Update errors appear on the page only as
  "didn't finish"; the details are in the server logs (Vercel → Logs).
- `vercel.json` also runs a check every day at 19:00 UTC (midnight in Pakistan), after the evening email, so
  prices stay current even when nobody visits. Hobby plans allow one cron run a day; on Pro you can change the
  schedule to `0 */2 * * *` for a check every 2 hours.

## Run locally

```bash
pip install -r requirements.txt
uvicorn app:app --reload        # http://127.0.0.1:8000, data goes to data/funds.db (SQLite)
python test_core.py              # parser, metrics and API self-check
```

The server reads `.env` automatically. Open the page and it imports from the inbox by itself.
Set `DATABASE_URL` in `.env` to use the Neon database instead of SQLite.

To add a screenshot or saved email:
```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: image/png" --data-binary @prices.png <url>/api/ingest
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: message/rfc822" --data-binary @email.eml <url>/api/ingest
```

## Metrics

- **Reported** (straight from the email): NAV, MTD, FYTD, CYTD, the last two fiscal years, since inception.
- **Since launch, per year**: since-inception return as a yearly rate, so old and new funds compare fairly.
- **Last move, 1 year, volatility, drawdown, growth charts**: calculated from a total-return index rebuilt from the reported FYTD.
  NAV drops on dividend payouts, so it isn't used directly. These metrics get better as history builds up.
- **Entry / exit load**: offer price above NAV, and repurchase price below NAV. **Rank**: position within the category by FYTD.
- Money market and income returns are annualized. Everything else is absolute. A fund counts as annualized when its
  category or name says so (`ANNUALIZED` in `core.py`) or its NAV creeps up like a cash fund's. Rankings compare
  funds only with peers in the same category that quote returns the same way.
- The AMC renames funds between email templates ("Paidaar Munafa Plan-34" → "Paidar Munafa Plan 34"). Names whose
  NAV runs on continuously are merged into one history under the newest name.

"Your funds" (the ☆ stars) is saved in each viewer's own browser.
