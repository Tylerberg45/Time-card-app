# HazenTime — AI Project Handoff

This README is the source-of-truth handoff for future AI work on this project. Read it before changing code. The application is a live, shared timekeeping and job-record system for Hazen Construction; preserving existing records and permissions is more important than adding a feature quickly.

## Project identity

- Product name: **HazenTime** (the app header still says “Time Card”).
- Customer/workflow: Corbin administers Hazen Construction; employees record their own hours.
- Live site: <https://time-card.tylerberg45.chatgpt.site>
- Public source backup: <https://github.com/Tylerberg45/Time-card-app>
- Sites project ID: `appgprj_6a6b30764aec8191940816fd9528c54d`
- Last published version at the time this README was written: **Version 30**.
- Last Sites source commit: `fc726e5629641c350899fe669413516ca6e2285d`.
- Last public GitHub backup commit: <https://github.com/Tylerberg45/Time-card-app/commit/b73a1986459689caca8cfeb914e9f86c3fd92a36>

The local project directory may differ between sessions. The repository root is the directory containing this README and `.openai/hosting.json`.

## Non-negotiable safety rules

1. **Never delete or replace production records.** Time entries, pay history, payment status, time-off requests, job reviews, expenses, audit history, and receipt images must survive deployments and UI changes.
2. **Keep all authorization server-side.** The UI is not a security boundary. Employees may read or change only their own allowed records; administrative actions require `user.role === "admin"` in the API route.
3. **Do not put secrets in source control.** OneSignal API keys and any future credentials belong in encrypted Sites/Railway environment secrets, never in GitHub, README files, logs, or client code.
4. **Use additive migrations.** `ensureSchema()` in `app/api/timecard/route.ts` creates missing tables/indexes with `CREATE TABLE IF NOT EXISTS`. New columns/tables must have safe defaults. Do not use destructive migrations against the live database.
5. **Do not assume GitHub is a data backup.** GitHub contains source only. Production records are in the hosted D1 database and R2 bucket.
6. **Ask for explicit approval before a public deployment** unless the user directly says to publish/deploy. A saved Sites version is not live until deployed.
7. Preserve both the beta Home Screen and its rollback path. The classic admin screen is the reference `classic-admin-tabs-v26` and the beta switch must keep working.

## What the app does today

### Login and access

- First launch creates one administrator with a name and 6-digit PIN.
- Login presents active employee/admin names, then a PIN prompt.
- Employee PINs may be 4–6 digits; the administrator PIN is 6 digits.
- PINs are salted and PBKDF2-hashed; plaintext PINs are never stored.
- Sessions use hashed tokens in the database and secure, HTTP-only cookies.
- Repeated bad PIN attempts trigger escalating cooldowns.
- Removing an employee archives/deactivates the account, signs out active sessions, and preserves records. Restore is available to the administrator.

### Time cards

- Weeks run **Sunday through Saturday**.
- A calendar-style time card lets a user enter hours by work date and job, with notes and optional flags/reasons.
- Administrators can view/edit employee cards and their own hours.
- Employees can choose active jobs. Administrators can also use completed jobs.
- Future dates and more than 24 total hours in a day warn before saving; they are not silently blocked.
- Each user/job/date has one time-entry row. Moving an entry to another job is administrator-only. If the destination already has an entry for that employee/date, the API refuses the move so hours are not accidentally merged.

### Jobs and mismatch reviews

- Administrators can add and rename jobs.
- **Complete** hides a job from employee entry while retaining all existing hours and reports. Administrators can still enter/edit hours on it and can reopen it.
- A heuristic mismatch detector looks for coworkers whose daily hours and prior work patterns suggest they may have selected different job names for the same work. It creates a pending review; it never moves hours automatically.
- Corbin can move one employee’s affected entries to Job A, Job B, another job, or confirm that the work was separate. Collisions are blocked and stale reviews are closed safely.
- Pending mismatch reviews appear in the Command Center, Job reviews, and (when configured) an administrator push notification.

### Reports and pay records

- Administrator **Pay reports** and employee **Pay history** support selected week, year-to-date, last year, and custom date ranges.
- Reports calculate gross internal pay using the effective-dated rate for each work date. They are not official W-2/1099 paystubs and do not calculate taxes, deductions, or net pay.
- Reports can be downloaded, printed, shared/emailed as PDF, or exported as CSV.
- Payment-issued and employee-confirmed-received statuses are separate. Payment date, method, and optional check number are preserved.
- Administrator **Job hours** shows total hours per job and a breakdown of each person’s hours, including completed jobs and archived employees.

### Time off and notifications

- Employees submit date-range time-off requests.
- Corbin approves/denies requests; employees receive a push notification when configured.
- Corbin receives new-request and day-before reminder pushes when OneSignal is configured.
- Push links deep-link to the relevant request or review. Safari web push does not provide reliable approve/deny buttons inside the notification itself, so the app opens the exact page for review.
- Each person enables push notifications from the app on their own device. iPhone web push requires adding the site to the Home Screen.

### Receipt expense tracker (Version 30)

- Administrator-only **Expenses** screen.
- Capture a receipt with a phone camera or upload an image from a Mac/desktop.
- Assign the expense to any job, including a completed job, and choose a category: Materials, Fuel, Equipment, Subcontractor, Meals, Office, Travel, or Other.
- Store purchase date, amount, vendor, notes, receipt image, extracted text, and a reviewed flag.
- OCR runs on the device with Tesseract.js after a photo is selected. Corbin can edit/correct the extracted text before marking the record reviewed. If OCR cannot load or finds no text, manual entry still works.
- Receipt images are stored in the private R2 bucket under `receipts/`; the database stores only the object key and searchable metadata. `GET ?receiptImage=<id>` requires an administrator session and returns a private, no-store image response.
- Expense metadata is included in manual and daily JSON backups. Receipt image objects remain in R2 separately; do not expose them publicly.
- Expenses can be edited or deleted by an administrator, with an audit-log entry for each change.

## Data and storage

`.openai/hosting.json` declares the production bindings:

```json
{
  "d1": "DB",
  "project_id": "appgprj_6a6b30764aec8191940816fd9528c54d",
  "r2": "BACKUPS"
}
```

- **D1 binding `DB`** stores users, rates, jobs, time entries, pay weeks, sessions, login attempts, audit log, time-off requests, mismatch reviews, and expenses.
- **R2 binding `BACKUPS`** stores daily private JSON backups under `daily/YYYY-MM-DD.json` (45-day retention) and receipt images under `receipts/`.
- The Worker binds these resources to globals used by the API: `__TIME_CARD_DB`, `__TIME_CARD_BACKUPS`, and `__TIME_CARD_PUSH`.
- `app/api/timecard/route.ts` is the single API surface. It calls `ensureSchema()` before reads/writes so an additive schema change can roll forward safely.
- `worker/index.ts` runs scheduled time-off reminders, mismatch scans, and daily backups.

### Current database tables

Defined in `db/schema.ts` and also guarded by `ensureSchema()`:

| Table | Purpose |
|---|---|
| `users` | Admin/employee identity, active/archive state, hashed PIN, current rate |
| `employee_pay_rates` | Effective-dated employee rate history |
| `jobs` | Job names and active/completed state |
| `time_entries` | One user/job/date hour record, notes, flags, resolutions |
| `pay_weeks` | Weekly issued/received payment metadata |
| `sessions` | Hashed login sessions |
| `login_attempts` | PIN throttling/cooldown state |
| `audit_log` | Append-only human-readable change history |
| `time_off_requests` | Employee requests and administrator decisions |
| `job_mismatch_reviews` | Pending/resolved job-selection suggestions |
| `expenses` | Job-linked receipt expense metadata and OCR review state |

## Important implementation files

- `app/TimeCardApp.tsx` — client UI, navigation, beta Command Center, time cards, reports, job reviews, expenses, push setup.
- `app/api/timecard/route.ts` — authenticated API, schema bootstrap, all reads/writes, CSV/backup downloads, private receipt image responses.
- `app/globals.css` — responsive phone layout and Mac/desktop admin layout.
- `app/job-mismatch-logic.mjs` — pure mismatch-detection heuristic.
- `db/schema.ts` — Drizzle schema reference.
- `worker/index.ts` — Cloudflare Worker entry point, bindings, scheduled jobs, daily backups.
- `tests/rendered-html.test.mjs` — source/regression coverage for the app’s major workflows.
- `tests/job-mismatch.test.mjs` — mismatch heuristic tests, including the Kaufman Barn/Blanchard Road example.
- `drizzle/` — generated migration history; live safety still comes from the additive `ensureSchema()` bootstrap.

## UI and product decisions to preserve

- The beta admin Home Screen is intentionally a Command Center with attention items and quick actions. The classic tabbed screen remains available through “Use classic Home Screen.”
- Desktop/Mac administrators get a left navigation rail and a wide two-column Command Center. Phone navigation remains the compact mobile layout.
- Employees must not see Corbin-only pay reports, job reviews, expenses, admin backup tools, or administrator release notes.
- “What’s new” is one-time per release per user and role-filtered. Update `RELEASE_NOTES.version`, date, and audience-specific item whenever a user-facing feature ships.
- Background refresh checks for data changes every 15 seconds and on focus; it avoids interrupting active/unsaved entry forms. A new program build may reload once.
- No feature should require employees to close and reopen the app repeatedly.

## Intentionally deferred

Do not add these without a new product decision:

- Passkeys/Face ID, until the permanent public domain/App Store direction is settled.
- Automatic Mac backup synchronization. The user explicitly deferred this. Existing hosted daily backups remain in place, but GitHub is source-only.
- Full payroll processing, tax filing, W-2/1099 generation, withholding, direct-deposit banking, or storage of Social Security/bank data. The recommended future design is an embedded payroll provider behind HazenTime.
- A native App Store application and true Safari notification action buttons.
- Employee-facing expense entry. The receipt tracker is intentionally administrator-only for now.

## Development and verification

Prerequisite: Node.js `>=22.13.0` on Linux for the bounded Sites scripts.

```bash
npm run lint
npm test
npm run build
npm run validate:artifact
```

`npm test` runs the verified build and all Node tests. A normal feature checkpoint should have clean `git diff --check`, lint with no errors, a successful build, and all tests passing. The current accepted lint output includes one non-blocking Next.js warning for the receipt preview `<img>`.

## Sites release procedure

1. Read this README and inspect the current source before editing.
2. Make a minimal, additive change with server-side authorization.
3. Run lint, build, artifact validation, and tests.
4. Commit the exact source state and push it to the Sites-bound repository using a short-lived Sites write credential. Never expose that credential.
5. Package the successful build with the Sites hosting helper, then call `sites_save_site_version` with the exact full commit SHA and archive path.
6. A saved version is not public. Ask for explicit approval unless the user already said to publish.
7. On approval, deploy that exact saved version with `sites_deploy_site_version`, then poll `sites_get_deployment_status` until `succeeded` or a clear failure.
8. Update the public GitHub source backup when requested or when maintaining the promised recovery copy. Never upload the D1 database, R2 receipt images, OneSignal secrets, or generated `.artifacts/` archives.
9. Report the live URL, version, verification result, and any one-time refresh requirement clearly.

## Handoff checklist for a future AI

- Read this README first.
- Check `.openai/hosting.json` and use its exact project ID; never invent a new Site.
- Inspect `git log`, current source, and deployment status before assuming what is live.
- Treat all production records as valuable and all secrets as unavailable to source code.
- Preserve employee/admin separation and the classic beta rollback.
- Run tests after changes. If a test exposes a stale README or old requirement, update the documentation only after confirming the current product behavior.
- If the user asks to “publish,” deploy the saved version only after verifying that its commit and archive match.
