import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;
const appleWebAppMeta =
  /<meta(?=[^>]*\bname=["']apple-mobile-web-app-capable["'])(?=[^>]*\bcontent=["']yes["'])[^>]*>/i;
const appleTouchIcon =
  /<link(?=[^>]*\brel=["']apple-touch-icon["'])(?=[^>]*\bhref=["']\/apple-touch-icon\.png["'])[^>]*>/i;
const webAppManifest =
  /<link(?=[^>]*\brel=["']manifest["'])(?=[^>]*\bhref=["']\/manifest\.webmanifest["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, appleWebAppMeta);
  assert.match(html, appleTouchIcon);
  assert.match(html, webAppManifest);
});

test("exposes a no-cache build identifier for automatic updates", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("version-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/api/timecard?version=1"),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  const result = await response.json();
  assert.equal(typeof result.buildId, "string");
  assert.ok(result.buildId.length > 0);
});

test("ships one-time release notes for the latest user-facing changes", async () => {
  const source = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");

  assert.match(source, /hazentime-whats-new:/);
  assert.match(source, /Calendar-style time cards/);
  assert.match(source, /Time-off calendar/);
  assert.match(source, /Pay reports/);
  assert.match(source, /Automatic updates/);
  assert.match(source, /Push notifications/);
  assert.match(source, /Time-off push notifications/);
  assert.match(source, /Download your pay history/);
  assert.match(source, /Enable push notifications/);
  assert.match(source, /item\.audience === data\.user\?\.role/);
});

test("keeps the classic admin screen as an easy beta rollback", async () => {
  const source = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");

  assert.match(source, /BETA_HOME_REFERENCE_CLASSIC_V26/);
  assert.match(source, /const BETA_HOME_DEFAULT = true/);
  assert.match(source, /BETA_HOME_STORAGE_PREFIX/);
  assert.match(source, /Beta Home Screen/);
  assert.match(source, /Command Center/);
  assert.match(source, /Use classic Home Screen/);
  assert.match(source, /classic-admin-tabs-v26/);
  assert.match(source, /localStorage\.setItem\(`\$\{BETA_HOME_STORAGE_PREFIX}/);
});

test("provides a desktop admin layout without changing the mobile navigation", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(appSource, /className=\{isAdmin \? "adminNavArea" : "navArea"\}/);
  assert.match(cssSource, /@media \(min-width:960px\)/);
  assert.match(cssSource, /grid-template-columns:220px minmax\(0,1fr\)/);
  assert.match(cssSource, /\.adminNavArea \.tabs \{ display:grid/);
  assert.match(cssSource, /\.commandCenter \{ display:grid/);
});

test("gives employees a private downloadable pay history", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(appSource, /isAdmin \? "Pay reports" : "Pay history"/);
  assert.match(appSource, /Selected time-card week/);
  assert.match(appSource, /Share \/ email PDF/);
  assert.match(appSource, /Open \/ print PDF/);
  assert.match(appSource, /Download PDF/);
  assert.match(apiSource, /const employeeId = user\.role === "admin" \? requestedEmployeeId : user\.id/);
});

test("gives administrators an all-time job-hours report with employee breakdowns", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(appSource, />Job hours</);
  assert.match(appSource, /All recorded hours for each job, with a breakdown of who worked them/);
  assert.match(apiSource, /report"\) === "job-hours"/);
  assert.match(apiSource, /Administrator access required/);
  assert.match(apiSource, /GROUP BY j\.id, j\.name, j\.active, u\.id, u\.name, u\.active/);
});

test("adds an admin receipt expense tracker with private images and OCR review", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

  assert.match(schema, /export const expenses/);
  assert.match(appSource, />Expenses</);
  assert.match(appSource, /Receipt photo/);
  assert.match(appSource, /Extracted text/);
  assert.match(appSource, /createWorker\("eng"\)/);
  assert.match(apiSource, /if \(action === "saveExpense"\)/);
  assert.match(apiSource, /receiptFile\.arrayBuffer\(\)/);
  assert.match(apiSource, /receiptImage/);
  assert.match(apiSource, /Administrator access required/);
  assert.match(workerSource, /expenses: expenses\.results/);
});

test("completes jobs without losing hours and lets administrators move entries", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(appSource, /action: "completeJob"/);
  assert.match(appSource, /action: "reopenJob"/);
  assert.match(appSource, /action: "moveEntry"/);
  assert.match(appSource, /Hidden from employees · Hours preserved/);
  assert.match(apiSource, /if \(action === "moveEntry"\)/);
  assert.match(apiSource, /UPDATE time_entries SET job_id = \?, updated_at = \? WHERE id = \?/);
  assert.match(apiSource, /if \(action === "completeJob" \|\| action === "reopenJob"\)/);
  assert.doesNotMatch(apiSource, /completeJob[\s\S]{0,500}DELETE FROM time_entries/);
});

test("detects and reviews possible job mismatches without changing hours automatically", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

  assert.match(schema, /jobMismatchReviews/);
  assert.match(appSource, />Job reviews/);
  assert.match(appSource, /Move \{review\.userBName\} to \{review\.jobAName\}/);
  assert.match(appSource, /No change — they worked separate jobs/);
  assert.match(apiSource, /if \(action === "resolveJobMismatch"\)/);
  assert.match(apiSource, /Possible job mismatch/);
  assert.match(apiSource, /INSERT OR IGNORE INTO job_mismatch_reviews/);
  assert.match(workerSource, /processJobMismatchReviews/);
  assert.doesNotMatch(apiSource, /detectJobMismatches[\s\S]{0,500}UPDATE time_entries/);
});

test("lets the signed-in administrator use completed jobs while employees see only active choices", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(appSource, /\{data\.user\.name\} \(admin\)/);
  assert.match(appSource, /const selectableJobs = isAdmin \? jobs : jobs\.filter/);
  assert.match(apiSource, /user\.role === "admin"[\s\S]{0,300}SELECT id FROM jobs WHERE id = \?/);
  assert.match(apiSource, /role = 'employee' OR id = \?/);
});

test("notifies employees when a time-off request is reviewed", async () => {
  const source = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(source, /Time off approved/);
  assert.match(source, /Time-off request denied/);
  assert.match(source, /employeePushSent/);
});

test("shows employees only approved team time off", async () => {
  const source = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");

  assert.match(source, /item\.status === "approved" \|\| \(isAdmin && item\.status === "pending"\)/);
  assert.match(source, /No approved team time off this month/);
  assert.match(source, /isAdmin && <span><i className="legendPending"/);
});

test("protects PIN sign-in with escalating cooldowns", async () => {
  const source = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

  assert.match(schema, /loginAttempts/);
  assert.match(source, /loginDelaySeconds/);
  assert.match(source, /Too many incorrect PIN attempts/);
  assert.match(source, /"Retry-After"/);
  assert.match(source, /secureEqual/);
});

test("removes employees without deleting their records", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(appSource, /Their records will be preserved/);
  assert.match(appSource, /restoreEmployee/);
  assert.match(apiSource, /UPDATE users SET active = 0/);
  assert.match(apiSource, /while preserving all records/);
  assert.doesNotMatch(apiSource, /DELETE FROM users WHERE id = \? AND role = 'employee'/);
});

test("keeps payment-issued and payment-received records separate", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(appSource, /Payment issued/);
  assert.match(appSource, /Payment received/);
  assert.match(appSource, /Payment date/);
  assert.match(appSource, /Direct deposit/);
  assert.match(apiSource, /payment_issued/);
  assert.match(apiSource, /payment_received/);
});

test("warns without blocking unusual time entries", async () => {
  const appSource = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(appSource, /This date is in the future/);
  assert.match(appSource, /Save it anyway/);
  assert.match(apiSource, /warningsAccepted/);
  assert.match(apiSource, /This entry is dated in the future/);
});

test("creates private daily backups and deep-links time-off alerts", async () => {
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");
  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));

  assert.equal(hosting.r2, "BACKUPS");
  assert.match(workerSource, /createDailyBackup/);
  assert.match(workerSource, /slice\(45\)/);
  assert.match(workerSource, /request=\$\{request\.id\}/);
  assert.match(apiSource, /web_buttons/);
  assert.match(apiSource, /decision=approved/);
  assert.match(apiSource, /decision=denied/);
});
