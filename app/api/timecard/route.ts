import { detectJobMismatches } from "../../job-mismatch-logic.mjs";

type Payload = Record<string, unknown>;
type SessionUser = { id: number; name: string; role: "admin" | "employee" };
type PushResult = { sent: boolean; id?: string };
type PushButton = { id: string; text: string; url: string };

declare const __TIME_CARD_BUILD_ID__: string;

const COOKIE = "timecard_session";
const encoder = new TextEncoder();

function database() {
  const db = (globalThis as typeof globalThis & { __TIME_CARD_DB?: D1Database }).__TIME_CARD_DB;
  if (!db) throw new Error("The time card database is unavailable.");
  return db;
}

function receiptBucket() {
  return (globalThis as typeof globalThis & { __TIME_CARD_BACKUPS?: R2Bucket }).__TIME_CARD_BACKUPS;
}

function pushConfig() {
  const config = (globalThis as typeof globalThis & {
    __TIME_CARD_PUSH?: { appId?: string; apiKey?: string; safariWebId?: string };
  }).__TIME_CARD_PUSH;
  return {
    appId: config?.appId?.trim() ?? "",
    apiKey: config?.apiKey?.trim() ?? "",
    safariWebId: config?.safariWebId?.trim() ?? "",
  };
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}

function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

function addUtcDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayEastern() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dateRangeLabel(startDate: string, endDate: string) {
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const start = format.format(new Date(`${startDate}T12:00:00Z`));
  const end = format.format(new Date(`${endDate}T12:00:00Z`));
  return startDate === endDate ? start : `${start}–${end}`;
}

async function sendPush(
  userIds: number[],
  title: string,
  message: string,
  url: string,
  buttons: PushButton[] = [],
): Promise<PushResult> {
  const { appId, apiKey } = pushConfig();
  if (!appId || !apiKey || !userIds.length) return { sent: false };
  try {
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app_id: appId,
        include_aliases: { external_id: userIds.map((id) => `timecard-user-${id}`) },
        target_channel: "push",
        headings: { en: title },
        contents: { en: message },
        url,
        ...(buttons.length ? { web_buttons: buttons.slice(0, 2) } : {}),
      }),
    });
    const result = await response.json() as { id?: string };
    if (!response.ok) throw new Error(`OneSignal returned ${response.status}.`);
    return { sent: Boolean(result.id), id: result.id };
  } catch (error) {
    console.error("Push notification failed", error);
    return { sent: false };
  }
}

async function refreshJobMismatchReviews(request: Request) {
  const db = database();
  const rows = (await db.prepare(
    `SELECT t.id, t.user_id AS userId, u.name AS userName, t.job_id AS jobId, j.name AS jobName,
       t.work_date AS workDate, t.hours
     FROM time_entries t
     JOIN users u ON u.id = t.user_id
     JOIN jobs j ON j.id = t.job_id
     WHERE u.role = 'employee' AND t.hours > 0
     ORDER BY t.work_date, t.user_id, t.job_id`,
  ).all()).results as Array<{
    id: number; userId: number; userName: string; jobId: number; jobName: string; workDate: string; hours: number;
  }>;
  const detected = detectJobMismatches(rows);
  const fingerprints = new Set(detected.map((item) => item.fingerprint));
  const now = new Date().toISOString();

  for (const review of detected) {
    await db.prepare(
      `INSERT OR IGNORE INTO job_mismatch_reviews
       (fingerprint, user_a_id, user_b_id, job_a_id, job_b_id, start_date, end_date, dates, entry_ids_a, entry_ids_b,
        hours_a, hours_b, confidence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      review.fingerprint,
      review.userAId,
      review.userBId,
      review.jobAId,
      review.jobBId,
      review.startDate,
      review.endDate,
      JSON.stringify(review.dates),
      JSON.stringify(review.entryIdsA),
      JSON.stringify(review.entryIdsB),
      review.hoursA,
      review.hoursB,
      review.confidence,
      now,
      now,
    ).run();
  }

  const pending = (await db.prepare(
    `SELECT id, fingerprint, notification_sent_at AS notificationSentAt FROM job_mismatch_reviews WHERE status = 'pending'`,
  ).all()).results as Array<{ id: number; fingerprint: string; notificationSentAt: string | null }>;
  for (const stored of pending) {
    if (!fingerprints.has(stored.fingerprint)) {
      await db.prepare(`UPDATE job_mismatch_reviews SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(now, stored.id).run();
    }
  }

  const byFingerprint = new Map(detected.map((item) => [item.fingerprint, item]));
  const admins = (await db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id`).all()).results as Array<{ id: number }>;
  const adminIds = admins.map((item) => Number(item.id));
  for (const stored of pending) {
    if (stored.notificationSentAt || !fingerprints.has(stored.fingerprint)) continue;
    const review = byFingerprint.get(stored.fingerprint);
    if (!review) continue;
    const claimed = await db.prepare(
      `UPDATE job_mismatch_reviews SET notification_sent_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND notification_sent_at IS NULL`,
    ).bind(now, now, stored.id).run();
    if (!claimed.meta.changes) continue;
    const range = dateRangeLabel(review.startDate, review.endDate);
    const result = await sendPush(
      adminIds,
      "Possible job mismatch",
      `${review.userAName} used ${review.jobAName} while ${review.userBName} used ${review.jobBName} for ${range}. Tap to review.`,
      new URL(`/?tab=jobreviews&review=${stored.id}`, request.url).toString(),
      [{ id: "review", text: "Review", url: new URL(`/?tab=jobreviews&review=${stored.id}`, request.url).toString() }],
    );
    if (result.sent) {
      await db.prepare(`UPDATE job_mismatch_reviews SET notification_id = ?, updated_at = ? WHERE id = ?`)
        .bind(result.id ?? "", now, stored.id).run();
      await db.prepare(
        `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, summary, details, created_at)
         VALUES (NULL, 'HazenTime', 'detect', 'job_mismatch', ?, ?, ?, ?)`,
      ).bind(
        String(stored.id),
        `Detected a possible job mismatch for ${range}`,
        JSON.stringify({ fingerprint: review.fingerprint, userA: review.userAName, jobA: review.jobAName, userB: review.userBName, jobB: review.jobBName }),
        now,
      ).run();
    } else {
      await db.prepare(`UPDATE job_mismatch_reviews SET notification_sent_at = NULL, updated_at = ? WHERE id = ?`)
        .bind(now, stored.id).run();
    }
  }
}

function parsedNumberArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter((item) => Number.isInteger(item) && item > 0) : [];
  } catch {
    return [];
  }
}

function parsedStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function digest(value: string) {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function pinHash(pin: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    // Cloudflare Workers caps PBKDF2 at 100,000 iterations.
    { name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: 100_000 },
    key,
    256,
  );
  return b64(new Uint8Array(bits));
}

function secureEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function loginDelaySeconds(failedCount: number) {
  if (failedCount < 5) return 0;
  return Math.min(15 * 60, 60 * (2 ** Math.min(failedCount - 5, 4)));
}

async function ensureSchema() {
  const db = database();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, hourly_rate REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS employee_pay_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, rate REAL NOT NULL DEFAULT 0, effective_from TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS employee_pay_rate_user_date ON employee_pay_rates(user_id, effective_from)`,
    `INSERT OR IGNORE INTO employee_pay_rates (user_id, rate, effective_from, created_at) SELECT id, hourly_rate, substr(created_at, 1, 10), created_at FROM users WHERE role = 'employee'`,
    `CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS time_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL REFERENCES jobs(id), work_date TEXT NOT NULL, hours REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', flagged INTEGER NOT NULL DEFAULT 0, flag_reason TEXT NOT NULL DEFAULT '', resolution TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS entry_user_job_date ON time_entries(user_id, job_id, work_date)`,
    `CREATE TABLE IF NOT EXISTS pay_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, payment_date TEXT NOT NULL DEFAULT '', payment_method TEXT NOT NULL DEFAULT '', check_number TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS pay_week_user_start ON pay_weeks(user_id, week_start)`,
    `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS login_attempts (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, failed_count INTEGER NOT NULL DEFAULT 0, window_started_at TEXT NOT NULL, locked_until TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_name TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log(created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS time_off_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, start_date TEXT NOT NULL, end_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, review_note TEXT NOT NULL DEFAULT '', requested_at TEXT NOT NULL, reviewed_at TEXT, updated_at TEXT NOT NULL, reminder_notification_id TEXT, reminder_sent_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS time_off_user_dates ON time_off_requests(user_id, start_date, end_date)`,
    `CREATE INDEX IF NOT EXISTS time_off_status_start ON time_off_requests(status, start_date)`,
    `CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES jobs(id), created_by INTEGER NOT NULL REFERENCES users(id), purchase_date TEXT NOT NULL, vendor TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other', amount REAL NOT NULL DEFAULT 0, sales_tax REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', ocr_text TEXT NOT NULL DEFAULT '', reviewed INTEGER NOT NULL DEFAULT 0, receipt_key TEXT NOT NULL DEFAULT '', receipt_type TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS expenses_purchase_date ON expenses(purchase_date)`,
    `CREATE INDEX IF NOT EXISTS expenses_job_date ON expenses(job_id, purchase_date)`,
  ];
  await db.batch(statements.map((sql) => db.prepare(sql)));
  // Version 30 created expenses before sales-tax tracking was added. D1 does not
  // support ADD COLUMN IF NOT EXISTS, so an already-migrated column is ignored.
  try { await db.prepare(`ALTER TABLE expenses ADD COLUMN sales_tax REAL NOT NULL DEFAULT 0`).run(); } catch { /* already present */ }
}

async function audit(
  actor: SessionUser,
  action: string,
  targetType: string,
  targetId: string | number,
  summary: string,
  details: Record<string, unknown> = {},
) {
  await database().prepare(
    `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, summary, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(actor.id, actor.name, action, targetType, String(targetId), summary, JSON.stringify(details), new Date().toISOString()).run();
}

async function latestSyncToken() {
  const latest = await database().prepare(
    `SELECT id, created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; createdAt: string }>();
  return latest ? `${latest.id}:${latest.createdAt}` : "0";
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function cookieToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

async function currentUser(request: Request): Promise<SessionUser | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await database().prepare(
    `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
  ).bind(await digest(token), new Date().toISOString()).first<SessionUser>();
  return row ?? null;
}

async function requireUser(request: Request, admin = false) {
  const user = await currentUser(request);
  if (!user || (admin && user.role !== "admin")) return null;
  return user;
}

function sundayOf(value?: unknown) {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00Z`)
    : new Date();
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

async function dashboard(user: SessionUser, weekValue?: unknown, selectedId?: unknown) {
  const weekStart = sundayOf(weekValue);
  const end = new Date(`${weekStart}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const weekEnd = end.toISOString().slice(0, 10);
  const jobs = user.role === "admin"
    ? (await database().prepare(`SELECT id, name, active FROM jobs ORDER BY active DESC, name`).all()).results
    : (await database().prepare(
        `SELECT id, name, active FROM jobs
         WHERE active = 1 OR id IN (
           SELECT job_id FROM time_entries WHERE user_id = ? AND work_date BETWEEN ? AND ?
         )
         ORDER BY active DESC, name`,
      ).bind(user.id, weekStart, weekEnd).all()).results;
  const employees = user.role === "admin"
    ? (await database().prepare(`SELECT id, name, phone, hourly_rate AS hourlyRate FROM users WHERE role = 'employee' AND active = 1 ORDER BY name`).all()).results
    : [];
  const archivedEmployees = user.role === "admin"
    ? (await database().prepare(`SELECT id, name, phone, hourly_rate AS hourlyRate FROM users WHERE role = 'employee' AND active = 0 ORDER BY name`).all()).results
    : [];
  const firstEmployeeId = user.role === "admin" && employees.length
    ? Number((employees[0] as { id: number }).id)
    : user.id;
  const targetId = user.role === "admin" && Number(selectedId) ? Number(selectedId) : firstEmployeeId;
  const target = await database().prepare(
    `SELECT id, name, phone, hourly_rate AS hourlyRate FROM users
     WHERE id = ? AND active = 1 AND (role = 'employee' OR id = ?)`,
  ).bind(targetId, user.id).first();
  const entries = target
    ? (await database().prepare(
        `SELECT t.id, t.user_id AS userId, t.job_id AS jobId, t.work_date AS workDate, t.hours, t.note, t.flagged,
          t.flag_reason AS flagReason, t.resolution, t.resolved,
          COALESCE((SELECT r.rate FROM employee_pay_rates r WHERE r.user_id = t.user_id AND r.effective_from <= t.work_date ORDER BY r.effective_from DESC, r.id DESC LIMIT 1), u.hourly_rate) AS hourlyRate
         FROM time_entries t JOIN users u ON u.id = t.user_id
         WHERE t.user_id = ? AND t.work_date BETWEEN ? AND ? ORDER BY t.work_date, t.job_id`,
      ).bind(targetId, weekStart, weekEnd).all()).results
    : [];
  const pay = target
    ? await database().prepare(`SELECT paid, received, payment_date AS paymentDate, payment_method AS paymentMethod, check_number AS checkNumber FROM pay_weeks WHERE user_id = ? AND week_start = ?`).bind(targetId, weekStart).first<{ paid: number; received: number; paymentDate: string; paymentMethod: string; checkNumber: string }>()
    : null;
  const pending = user.role === "admin"
    ? await database().prepare(`SELECT COUNT(*) AS count FROM time_off_requests WHERE status = 'pending'`).first<{ count: number }>()
    : await database().prepare(`SELECT COUNT(*) AS count FROM time_off_requests WHERE user_id = ? AND status = 'pending'`).bind(user.id).first<{ count: number }>();
  const pendingJobReviews = user.role === "admin"
    ? await database().prepare(`SELECT COUNT(*) AS count FROM job_mismatch_reviews WHERE status = 'pending'`).first<{ count: number }>()
    : null;
  const push = pushConfig();
  return {
    configured: true,
    user,
    weekStart,
    weekEnd,
    jobs,
    employees,
    archivedEmployees,
    target,
    entries,
    paid: Boolean(pay?.paid),
    received: Boolean(pay?.received),
    paymentDate: pay?.paymentDate ?? "",
    paymentMethod: pay?.paymentMethod ?? "",
    checkNumber: pay?.checkNumber ?? "",
    pendingTimeOffCount: Number(pending?.count ?? 0),
    pendingJobReviewCount: Number(pendingJobReviews?.count ?? 0),
    syncToken: await latestSyncToken(),
    push: push.appId
      ? { configured: true, sendingConfigured: Boolean(push.apiKey), appId: push.appId, safariWebId: push.safariWebId, externalId: `timecard-user-${user.id}` }
      : { configured: false },
  };
}

async function payReport(employeeId: number, startDate: string, endDate: string) {
  const employee = await database().prepare(
    `SELECT id, name, hourly_rate AS hourlyRate FROM users WHERE id = ? AND role = 'employee'`,
  ).bind(employeeId).first<{ id: number; name: string; hourlyRate: number }>();
  if (!employee) return null;
  const [entries, paidWeeks] = await Promise.all([
    database().prepare(
      `SELECT t.work_date AS workDate, j.name AS job, t.hours,
         COALESCE((SELECT r.rate FROM employee_pay_rates r WHERE r.user_id = t.user_id AND r.effective_from <= t.work_date ORDER BY r.effective_from DESC, r.id DESC LIMIT 1), u.hourly_rate) AS hourlyRate
       FROM time_entries t JOIN jobs j ON j.id = t.job_id JOIN users u ON u.id = t.user_id
       WHERE t.user_id = ? AND t.work_date BETWEEN ? AND ?
       ORDER BY t.work_date, j.name`,
    ).bind(employeeId, startDate, endDate).all(),
    database().prepare(
      `SELECT week_start AS weekStart, paid, received, payment_date AS paymentDate, payment_method AS paymentMethod, check_number AS checkNumber
       FROM pay_weeks WHERE user_id = ? AND week_start BETWEEN ? AND ? ORDER BY week_start`,
    ).bind(employeeId, sundayOf(startDate), endDate).all(),
  ]);
  return {
    employee,
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    entries: entries.results,
    paidWeeks: paidWeeks.results,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("version") === "1") {
      return json(
        { buildId: __TIME_CARD_BUILD_ID__ },
        200,
        { "Cache-Control": "no-store, no-cache, must-revalidate" },
      );
    }
    await ensureSchema();
    if (url.searchParams.get("sync") === "1") {
      return json(
        { buildId: __TIME_CARD_BUILD_ID__, syncToken: await latestSyncToken() },
        200,
        { "Cache-Control": "no-store, no-cache, must-revalidate" },
      );
    }
    const count = await database().prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`).first<{ count: number }>();
    if (!count?.count) return json({ configured: false, syncToken: await latestSyncToken() });
    const user = await currentUser(request);
    if (!user) {
      const people = (await database().prepare(`SELECT id, name FROM users WHERE role = 'employee' AND active = 1 ORDER BY name`).all()).results;
      const admins = (await database().prepare(`SELECT id, name FROM users WHERE role = 'admin' AND active = 1 ORDER BY name`).all()).results;
      return json({ configured: true, authenticated: false, employees: people, admins, syncToken: await latestSyncToken() });
    }
    try {
      await refreshJobMismatchReviews(request);
    } catch (error) {
      // A review scan must never stop normal time-card access.
      console.error("Job mismatch scan failed", error);
    }
    if (url.searchParams.get("receiptImage")) {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const id = Number(url.searchParams.get("receiptImage"));
      if (!id) return json({ error: "Receipt not found." }, 404);
      const expense = await database().prepare(`SELECT receipt_key AS receiptKey, receipt_type AS receiptType FROM expenses WHERE id = ?`).bind(id).first<{ receiptKey: string; receiptType: string }>();
      const bucket = receiptBucket();
      if (!expense?.receiptKey || !bucket) return json({ error: "Receipt not found." }, 404);
      const object = await bucket.get(expense.receiptKey);
      if (!object) return json({ error: "Receipt not found." }, 404);
      return new Response(object.body, {
        headers: {
          "Content-Type": expense.receiptType || object.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "private, no-store",
        },
      });
    }
    if (url.searchParams.get("expenses") === "1") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const expenses = (await database().prepare(
        `SELECT e.id, e.job_id AS jobId, j.name AS jobName, j.active AS jobActive, e.purchase_date AS purchaseDate,
           e.vendor, e.category, e.amount, e.sales_tax AS salesTax, e.note, e.ocr_text AS ocrText, e.reviewed, e.receipt_key AS receiptKey,
           e.receipt_type AS receiptType, e.created_at AS createdAt, e.updated_at AS updatedAt, u.name AS createdByName,
           CASE WHEN trim(e.vendor) <> '' AND EXISTS (
             SELECT 1 FROM expenses d WHERE d.id <> e.id AND d.purchase_date = e.purchase_date
               AND lower(trim(d.vendor)) = lower(trim(e.vendor)) AND abs(d.amount - e.amount) < 0.005
           ) THEN 1 ELSE 0 END AS possibleDuplicate,
           (SELECT d.id FROM expenses d WHERE d.id <> e.id AND d.purchase_date = e.purchase_date
             AND lower(trim(d.vendor)) = lower(trim(e.vendor)) AND abs(d.amount - e.amount) < 0.005 ORDER BY d.id LIMIT 1) AS duplicateId
         FROM expenses e JOIN jobs j ON j.id = e.job_id JOIN users u ON u.id = e.created_by
         ORDER BY e.purchase_date DESC, e.id DESC`
      ).all()).results as Array<Record<string, unknown>>;
      const jobs = (await database().prepare(`SELECT id, name, active FROM jobs ORDER BY active DESC, LOWER(name)`).all()).results;
      return json({ expenses: expenses.map((expense) => ({ ...expense, reviewed: Boolean(expense.reviewed), hasReceipt: Boolean(expense.receiptKey), possibleDuplicate: Boolean(expense.possibleDuplicate), duplicateId: expense.duplicateId == null ? null : Number(expense.duplicateId) })), jobs });
    }
    if (url.searchParams.get("jobReviews") === "1") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const reviews = (await database().prepare(
        `SELECT r.id, r.start_date AS startDate, r.end_date AS endDate, r.dates, r.hours_a AS hoursA, r.hours_b AS hoursB,
           r.confidence, r.user_a_id AS userAId, ua.name AS userAName, r.user_b_id AS userBId, ub.name AS userBName,
           r.job_a_id AS jobAId, ja.name AS jobAName, r.job_b_id AS jobBId, jb.name AS jobBName,
           r.created_at AS createdAt
         FROM job_mismatch_reviews r
         JOIN users ua ON ua.id = r.user_a_id
         JOIN users ub ON ub.id = r.user_b_id
         JOIN jobs ja ON ja.id = r.job_a_id
         JOIN jobs jb ON jb.id = r.job_b_id
         WHERE r.status = 'pending'
         ORDER BY r.start_date DESC, r.id DESC`,
      ).all()).results as Array<Record<string, unknown>>;
      const jobs = (await database().prepare(`SELECT id, name, active FROM jobs ORDER BY active DESC, LOWER(name)`).all()).results;
      return json({
        reviews: reviews.map((review) => ({
          ...review,
          dates: parsedStringArray(String(review.dates ?? "[]")),
        })),
        jobs,
      });
    }
    if (url.searchParams.get("timeOff") === "1") {
      const month = url.searchParams.get("month") ?? todayEastern().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) return json({ error: "Choose a valid month." }, 400);
      const monthStart = `${month}-01`;
      const nextMonth = new Date(`${monthStart}T12:00:00Z`);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const monthEnd = addUtcDays(nextMonth.toISOString().slice(0, 10), -1);
      const select = `SELECT r.id, r.user_id AS userId, u.name AS userName, r.start_date AS startDate, r.end_date AS endDate,
        r.note, r.status, r.review_note AS reviewNote, r.requested_at AS requestedAt, r.reviewed_at AS reviewedAt
        FROM time_off_requests r JOIN users u ON u.id = r.user_id`;
      const result = user.role === "admin"
        ? await database().prepare(
            `${select} WHERE (r.end_date >= ? AND r.start_date <= ?) OR r.status = 'pending' ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.start_date, u.name`,
          ).bind(monthStart, monthEnd).all()
        : await database().prepare(
            `${select} WHERE ((r.end_date >= ? AND r.start_date <= ?) AND (r.status = 'approved' OR r.user_id = ?)) OR (r.user_id = ? AND r.status = 'pending') ORDER BY r.start_date, u.name`,
          ).bind(monthStart, monthEnd, user.id, user.id).all();
      const requests = (result.results as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        note: user.role === "admin" || Number(item.userId) === user.id ? item.note : "",
        reviewNote: user.role === "admin" || Number(item.userId) === user.id ? item.reviewNote : "",
      }));
      return json({ requests, monthStart, monthEnd });
    }
    if (url.searchParams.get("report") === "pay") {
      const requestedEmployeeId = Number(url.searchParams.get("employeeId"));
      const employeeId = user.role === "admin" ? requestedEmployeeId : user.id;
      const startDate = url.searchParams.get("startDate") ?? "";
      const endDate = url.searchParams.get("endDate") ?? "";
      if (!employeeId || !validDate(startDate) || !validDate(endDate) || endDate < startDate) {
        return json({ error: "Choose an employee and a valid date range." }, 400);
      }
      const report = await payReport(employeeId, startDate, endDate);
      return report ? json(report) : json({ error: "Employee not found." }, 404);
    }
    if (url.searchParams.get("report") === "job-hours") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const rows = (await database().prepare(
        `SELECT j.id AS jobId, j.name AS jobName, j.active AS jobActive, u.id AS userId, u.name AS employeeName,
           COALESCE(u.active, 1) AS userActive, COALESCE(SUM(t.hours), 0) AS hours
         FROM jobs j
         LEFT JOIN time_entries t ON t.job_id = j.id
         LEFT JOIN users u ON u.id = t.user_id
         GROUP BY j.id, j.name, j.active, u.id, u.name, u.active
         ORDER BY j.active DESC, LOWER(j.name), hours DESC, LOWER(u.name)`,
      ).all()).results as Array<Record<string, unknown>>;
      const jobs = new Map<number, { id: number; name: string; active: boolean; totalHours: number; people: Array<{ id: number; name: string; hours: number; archived: boolean }> }>();
      rows.forEach((row) => {
        const jobId = Number(row.jobId);
        const job = jobs.get(jobId) ?? { id: jobId, name: String(row.jobName), active: Boolean(row.jobActive), totalHours: 0, people: [] };
        const hours = Number(row.hours);
        job.totalHours += hours;
        if (row.userId != null) job.people.push({
          id: Number(row.userId),
          name: String(row.employeeName),
          hours,
          archived: !Boolean(row.userActive),
        });
        jobs.set(jobId, job);
      });
      return json({ jobs: [...jobs.values()] });
    }
    if (url.searchParams.get("report") === "job-costs") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const startDate = url.searchParams.get("startDate") ?? "";
      const endDate = url.searchParams.get("endDate") ?? "";
      if ((startDate && !validDate(startDate)) || (endDate && !validDate(endDate)) || (startDate && endDate && endDate < startDate)) {
        return json({ error: "Choose a valid date range." }, 400);
      }
      const [jobRows, laborRows, expenseRows] = await Promise.all([
        database().prepare(`SELECT id, name, active FROM jobs ORDER BY active DESC, LOWER(name)`).all(),
        database().prepare(
          `SELECT t.job_id AS jobId, t.user_id AS userId, u.name AS employeeName, u.active AS userActive, t.hours,
             COALESCE((SELECT r.rate FROM employee_pay_rates r WHERE r.user_id = t.user_id AND r.effective_from <= t.work_date ORDER BY r.effective_from DESC, r.id DESC LIMIT 1), u.hourly_rate) AS hourlyRate
           FROM time_entries t JOIN users u ON u.id = t.user_id
           WHERE (? = '' OR t.work_date >= ?) AND (? = '' OR t.work_date <= ?)`
        ).bind(startDate, startDate, endDate, endDate).all(),
        database().prepare(
          `SELECT e.job_id AS jobId, e.category, e.amount, e.sales_tax AS salesTax
           FROM expenses e WHERE (? = '' OR e.purchase_date >= ?) AND (? = '' OR e.purchase_date <= ?)`
        ).bind(startDate, startDate, endDate, endDate).all(),
      ]);
      const jobs = (jobRows.results as Array<Record<string, unknown>>).map((job) => ({
        id: Number(job.id), name: String(job.name), active: Boolean(job.active), totalHours: 0, laborCost: 0, expenseTotal: 0, salesTax: 0,
        totalCost: 0, people: [] as Array<{ id: number; name: string; hours: number; laborCost: number; archived: boolean }>,
        expenseCategories: [] as Array<{ category: string; amount: number; salesTax: number }>,
      }));
      const byJob = new Map(jobs.map((job) => [job.id, job]));
      const byPerson = new Map<string, { id: number; name: string; hours: number; laborCost: number; archived: boolean }>();
      for (const row of laborRows.results as Array<Record<string, unknown>>) {
        const job = byJob.get(Number(row.jobId)); if (!job) continue;
        const hours = Number(row.hours); const laborCost = hours * Number(row.hourlyRate);
        job.totalHours += hours; job.laborCost += laborCost;
        const personKey = `${job.id}:${Number(row.userId)}`;
        const person = byPerson.get(personKey) ?? { id: Number(row.userId), name: String(row.employeeName), hours: 0, laborCost: 0, archived: !Boolean(row.userActive) };
        person.hours += hours; person.laborCost += laborCost; byPerson.set(personKey, person);
      }
      for (const job of jobs) job.people = [...byPerson.entries()].filter(([key]) => key.startsWith(`${job.id}:`)).map(([, person]) => person).sort((a, b) => b.laborCost - a.laborCost);
      const categories = new Map<string, { category: string; amount: number; salesTax: number }>();
      for (const row of expenseRows.results as Array<Record<string, unknown>>) {
        const job = byJob.get(Number(row.jobId)); if (!job) continue;
        const amount = Number(row.amount); const salesTax = Number(row.salesTax);
        job.expenseTotal += amount; job.salesTax += salesTax;
        const category = String(row.category || "Other");
        const item = categories.get(`${job.id}:${category}`) ?? { category, amount: 0, salesTax: 0 };
        item.amount += amount; item.salesTax += salesTax; categories.set(`${job.id}:${category}`, item);
      }
      for (const job of jobs) { job.totalCost = job.laborCost + job.expenseTotal; job.expenseCategories = [...categories.entries()].filter(([key]) => key.startsWith(`${job.id}:`)).map(([, item]) => item).sort((a, b) => b.amount - a.amount); }
      return json({ startDate, endDate, jobs, totals: { hours: jobs.reduce((sum, job) => sum + job.totalHours, 0), laborCost: jobs.reduce((sum, job) => sum + job.laborCost, 0), expenses: jobs.reduce((sum, job) => sum + job.expenseTotal, 0), salesTax: jobs.reduce((sum, job) => sum + job.salesTax, 0), totalCost: jobs.reduce((sum, job) => sum + job.totalCost, 0) } });
    }
    const download = url.searchParams.get("download");
    if (download) {
      if (download === "csv") {
        if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
        const weekStart = sundayOf(url.searchParams.get("week"));
        const end = new Date(`${weekStart}T12:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 6);
        const weekEnd = end.toISOString().slice(0, 10);
        const employeeId = Number(url.searchParams.get("employeeId"));
        const rows = (await database().prepare(
          `SELECT u.name AS employee,
             COALESCE((SELECT r.rate FROM employee_pay_rates r WHERE r.user_id = t.user_id AND r.effective_from <= t.work_date ORDER BY r.effective_from DESC, r.id DESC LIMIT 1), u.hourly_rate) AS hourlyRate,
             t.work_date AS workDate, j.name AS job, t.hours, t.note,
             t.flagged, t.flag_reason AS flagReason, t.resolved, t.resolution,
             COALESCE(p.paid, 0) AS paid, COALESCE(p.received, 0) AS received,
             COALESCE(p.payment_date, '') AS paymentDate, COALESCE(p.payment_method, '') AS paymentMethod,
             COALESCE(p.check_number, '') AS checkNumber
           FROM time_entries t
           JOIN users u ON u.id = t.user_id
           JOIN jobs j ON j.id = t.job_id
           LEFT JOIN pay_weeks p ON p.user_id = t.user_id AND p.week_start = ?
           WHERE t.work_date BETWEEN ? AND ? AND (? = 0 OR t.user_id = ?)
           ORDER BY u.name, t.work_date, j.name`,
        ).bind(weekStart, weekStart, weekEnd, employeeId, employeeId).all()).results as Record<string, unknown>[];
        const header = ["Employee", "Date", "Job", "Hours", "Hourly Rate", "Entry Pay", "Note", "Flagged", "Flag Reason", "Resolved", "Resolution", "Payment Issued", "Employee Confirmed Received", "Payment Date", "Payment Method", "Check Number"];
        const lines = rows.map((row) => [
          row.employee, row.workDate, row.job, Number(row.hours).toFixed(2), Number(row.hourlyRate).toFixed(2),
          (Number(row.hours) * Number(row.hourlyRate)).toFixed(2), row.note,
          row.flagged ? "Yes" : "No", row.flagReason, row.resolved ? "Yes" : "No", row.resolution,
          row.paid ? "Yes" : "No", row.received ? "Yes" : "No", row.paymentDate, row.paymentMethod, row.checkNumber,
        ].map(csvCell).join(","));
        const csv = [header.map(csvCell).join(","), ...lines].join("\r\n");
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="time-card-${weekStart}.csv"`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (download === "pay-report") {
        const requestedEmployeeId = Number(url.searchParams.get("employeeId"));
        const employeeId = user.role === "admin" ? requestedEmployeeId : user.id;
        const startDate = url.searchParams.get("startDate") ?? "";
        const endDate = url.searchParams.get("endDate") ?? "";
        if (!employeeId || !validDate(startDate) || !validDate(endDate) || endDate < startDate) {
          return json({ error: "Choose an employee and a valid date range." }, 400);
        }
        const report = await payReport(employeeId, startDate, endDate);
        if (!report) return json({ error: "Employee not found." }, 404);
        const paidByWeek = new Map((report.paidWeeks as Array<Record<string, unknown>>).map((item) => [String(item.weekStart), item]));
        const header = ["Employee", "Date", "Week Starting", "Job", "Hours", "Hourly Rate Used", "Calculated Gross Pay", "Payment Issued", "Employee Confirmed Received", "Payment Date", "Payment Method", "Check Number"];
        const lines = (report.entries as Array<Record<string, unknown>>).map((row) => {
          const weekStart = sundayOf(row.workDate);
          const payment = paidByWeek.get(weekStart);
          return [
            report.employee.name, row.workDate, weekStart, row.job, Number(row.hours).toFixed(2), Number(row.hourlyRate).toFixed(2),
            (Number(row.hours) * Number(row.hourlyRate)).toFixed(2), payment?.paid ? "Yes" : "No", payment?.received ? "Yes" : "No",
            payment?.paymentDate ?? "", payment?.paymentMethod ?? "", payment?.checkNumber ?? "",
          ].map(csvCell).join(",");
        });
        const csv = [header.map(csvCell).join(","), ...lines].join("\r\n");
        const safeName = report.employee.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "employee";
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="pay-summary-${safeName}-${startDate}-to-${endDate}.csv"`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (download === "backup") {
        if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
        const [users, jobs, entries, payWeeks, payRateHistory, timeOff, jobMismatchReviews, expenses, history] = await Promise.all([
          database().prepare(`SELECT id, name, phone, role, hourly_rate AS hourlyRate, active, created_at AS createdAt FROM users ORDER BY id`).all(),
          database().prepare(`SELECT id, name, active, created_at AS createdAt FROM jobs ORDER BY id`).all(),
          database().prepare(`SELECT id, user_id AS userId, job_id AS jobId, work_date AS workDate, hours, note, flagged, flag_reason AS flagReason, resolution, resolved, updated_at AS updatedAt FROM time_entries ORDER BY work_date, id`).all(),
          database().prepare(`SELECT id, user_id AS userId, week_start AS weekStart, paid, received, payment_date AS paymentDate, payment_method AS paymentMethod, check_number AS checkNumber, updated_at AS updatedAt FROM pay_weeks ORDER BY week_start, id`).all(),
          database().prepare(`SELECT id, user_id AS userId, rate, effective_from AS effectiveFrom, created_at AS createdAt FROM employee_pay_rates ORDER BY user_id, effective_from, id`).all(),
          database().prepare(`SELECT id, user_id AS userId, start_date AS startDate, end_date AS endDate, note, status, reviewed_by AS reviewedBy, review_note AS reviewNote, requested_at AS requestedAt, reviewed_at AS reviewedAt, updated_at AS updatedAt, reminder_sent_at AS reminderSentAt FROM time_off_requests ORDER BY start_date, id`).all(),
          database().prepare(`SELECT id, fingerprint, user_a_id AS userAId, user_b_id AS userBId, job_a_id AS jobAId, job_b_id AS jobBId, start_date AS startDate, end_date AS endDate, dates, entry_ids_a AS entryIdsA, entry_ids_b AS entryIdsB, hours_a AS hoursA, hours_b AS hoursB, confidence, status, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt, selected_job_id AS selectedJobId, notification_id AS notificationId, notification_sent_at AS notificationSentAt, created_at AS createdAt, updated_at AS updatedAt FROM job_mismatch_reviews ORDER BY id`).all(),
          database().prepare(`SELECT id, job_id AS jobId, created_by AS createdBy, purchase_date AS purchaseDate, vendor, category, amount, sales_tax AS salesTax, note, ocr_text AS ocrText, reviewed, receipt_key AS receiptKey, receipt_type AS receiptType, created_at AS createdAt, updated_at AS updatedAt FROM expenses ORDER BY purchase_date, id`).all(),
          database().prepare(`SELECT id, actor_id AS actorId, actor_name AS actorName, action, target_type AS targetType, target_id AS targetId, summary, details, created_at AS createdAt FROM audit_log ORDER BY id`).all(),
        ]);
        const backup = JSON.stringify({
          format: "time-card-backup-v3",
          exportedAt: new Date().toISOString(),
          users: users.results, jobs: jobs.results, timeEntries: entries.results, payWeeks: payWeeks.results, payRateHistory: payRateHistory.results, timeOffRequests: timeOff.results, jobMismatchReviews: jobMismatchReviews.results, expenses: expenses.results, auditLog: history.results,
        }, null, 2);
        return new Response(backup, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="time-card-backup-${new Date().toISOString().slice(0, 10)}.json"`,
            "Cache-Control": "no-store",
          },
        });
      }
      return json({ error: "Unknown download." }, 400);
    }
    if (url.searchParams.get("history") === "1") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const history = (await database().prepare(
        `SELECT id, actor_name AS actorName, action, target_type AS targetType, target_id AS targetId, summary, details, created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT 250`,
      ).all()).results;
      return json({ history });
    }
    return json(await dashboard(user, url.searchParams.get("week"), url.searchParams.get("employeeId")));
  } catch (error) {
    console.error("Time card load failed", error);
    return json({ error: "The time card could not be loaded." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    let body: Payload;
    let receiptFile: File | null = null;
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData();
      body = {};
      for (const [key, value] of form.entries()) {
        if (key === "receipt" && value instanceof File) receiptFile = value;
        else if (typeof value === "string") body[key] = value;
      }
    } else {
      body = (await request.json()) as Payload;
    }
    const action = String(body.action ?? "");
    const now = new Date().toISOString();

    if (action === "setup") {
      const count = await database().prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`).first<{ count: number }>();
      if (count?.count) return json({ error: "Administrator setup is already complete." }, 409);
      const name = String(body.name ?? "").trim();
      const pin = String(body.pin ?? "");
      if (!name || !/^\d{6}$/.test(pin)) return json({ error: "Enter an admin name and a 6-digit PIN." }, 400);
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await database().prepare(`INSERT INTO users (name, role, pin_hash, pin_salt, created_at) VALUES (?, 'admin', ?, ?, ?)`)
        .bind(name, await pinHash(pin, salt), salt, now).run();
      await database().prepare(`INSERT INTO jobs (name, created_at) VALUES ('General', ?)`).bind(now).run();
      return json({ ok: true });
    }

    if (action === "login") {
      const id = Number(body.userId);
      const pin = String(body.pin ?? "");
      const person = await database().prepare(`SELECT id, name, role, pin_hash AS pinHash, pin_salt AS pinSalt FROM users WHERE id = ? AND active = 1`)
        .bind(id).first<SessionUser & { pinHash: string; pinSalt: string }>();
      if (!person) return json({ error: "That PIN is incorrect." }, 401);
      const attempts = await database().prepare(
        `SELECT failed_count AS failedCount, window_started_at AS windowStartedAt, locked_until AS lockedUntil FROM login_attempts WHERE user_id = ?`,
      ).bind(person.id).first<{ failedCount: number; windowStartedAt: string; lockedUntil: string }>();
      if (attempts?.lockedUntil && new Date(attempts.lockedUntil).getTime() > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((new Date(attempts.lockedUntil).getTime() - Date.now()) / 1000));
        return json({ error: `Too many incorrect PIN attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${retryAfter > 60 ? "s" : ""}.` }, 429, { "Retry-After": String(retryAfter) });
      }
      const matches = secureEqual(await pinHash(pin, person.pinSalt), person.pinHash);
      if (!matches) {
        const windowExpired = !attempts?.windowStartedAt || Date.now() - new Date(attempts.windowStartedAt).getTime() > 30 * 60_000;
        const failedCount = windowExpired ? 1 : Number(attempts?.failedCount ?? 0) + 1;
        const windowStartedAt = windowExpired ? now : attempts!.windowStartedAt;
        const delaySeconds = loginDelaySeconds(failedCount);
        const lockedUntil = delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : "";
        await database().prepare(
          `INSERT INTO login_attempts (user_id, failed_count, window_started_at, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET failed_count=excluded.failed_count, window_started_at=excluded.window_started_at, locked_until=excluded.locked_until, updated_at=excluded.updated_at`,
        ).bind(person.id, failedCount, windowStartedAt, lockedUntil, now).run();
        if (delaySeconds) return json({ error: `Too many incorrect PIN attempts. Try again in ${Math.ceil(delaySeconds / 60)} minute${delaySeconds > 60 ? "s" : ""}.` }, 429, { "Retry-After": String(delaySeconds) });
        return json({ error: "That PIN is incorrect." }, 401);
      }
      await database().prepare(`DELETE FROM login_attempts WHERE user_id = ?`).bind(person.id).run();
      const token = b64(crypto.getRandomValues(new Uint8Array(32)));
      const expires = new Date(Date.now() + 14 * 86400000).toISOString();
      await database().prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`)
        .bind(await digest(token), person.id, expires).run();
      const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
      return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=1209600` });
    }

    if (action === "logout") {
      const token = cookieToken(request);
      if (token) await database().prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await digest(token)).run();
      const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
      return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0` });
    }

    const user = await requireUser(request);
    if (!user) return json({ error: "Please sign in again." }, 401);

    if (action === "saveExpense") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const id = Number(body.id ?? 0);
      const jobId = Number(body.jobId ?? 0);
      const purchaseDate = String(body.purchaseDate ?? "");
      const vendor = String(body.vendor ?? "").trim().slice(0, 160);
      const category = String(body.category ?? "Other").trim().slice(0, 60) || "Other";
      const amount = Number(body.amount ?? 0);
      const salesTax = Number(body.salesTax ?? 0);
      const note = String(body.note ?? "").trim().slice(0, 1000);
      const ocrText = String(body.ocrText ?? "").trim().slice(0, 20000);
      const reviewed = body.reviewed === true || body.reviewed === "true";
      if (!jobId || !validDate(purchaseDate) || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000 || !Number.isFinite(salesTax) || salesTax < 0 || salesTax > amount) {
        return json({ error: "Choose a job, a valid date, and a valid expense amount." }, 400);
      }
      const job = await database().prepare(`SELECT id, name FROM jobs WHERE id = ?`).bind(jobId).first<{ id: number; name: string }>();
      if (!job) return json({ error: "That job no longer exists." }, 404);
      const before = id ? await database().prepare(`SELECT * FROM expenses WHERE id = ?`).bind(id).first<Record<string, unknown>>() : null;
      if (id && !before) return json({ error: "Expense not found." }, 404);
      let receiptKey = String(before?.receipt_key ?? before?.receiptKey ?? "");
      let receiptType = String(before?.receipt_type ?? before?.receiptType ?? "");
      if (receiptFile) {
        if (!receiptFile.type.startsWith("image/")) return json({ error: "Receipt must be an image." }, 400);
        if (receiptFile.size > 8 * 1024 * 1024) return json({ error: "Receipt images must be 8 MB or smaller." }, 413);
        if (!receiptBucket()) return json({ error: "Receipt storage is not available yet." }, 503);
        const extension = (receiptFile.type.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "jpg";
        receiptKey = `receipts/${id || crypto.randomUUID()}.${extension}`;
        receiptType = receiptFile.type;
        await receiptBucket()!.put(receiptKey, await receiptFile.arrayBuffer(), { httpMetadata: { contentType: receiptType } });
      }
      let savedId = id;
      if (id) {
        await database().prepare(
          `UPDATE expenses SET job_id = ?, purchase_date = ?, vendor = ?, category = ?, amount = ?, sales_tax = ?, note = ?, ocr_text = ?, reviewed = ?, receipt_key = ?, receipt_type = ?, updated_at = ? WHERE id = ?`,
        ).bind(jobId, purchaseDate, vendor, category, amount, salesTax, note, ocrText, reviewed ? 1 : 0, receiptKey, receiptType, now, id).run();
      } else {
        await database().prepare(
          `INSERT INTO expenses (job_id, created_by, purchase_date, vendor, category, amount, sales_tax, note, ocr_text, reviewed, receipt_key, receipt_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(jobId, user.id, purchaseDate, vendor, category, amount, salesTax, note, ocrText, reviewed ? 1 : 0, receiptKey, receiptType, now, now).run();
        const saved = await database().prepare(`SELECT id FROM expenses WHERE created_by = ? ORDER BY id DESC LIMIT 1`).bind(user.id).first<{ id: number }>();
        savedId = Number(saved?.id ?? 0);
        if (receiptFile && receiptKey.includes("${")) {
          // No-op: UUID keys are already unique; this branch exists only to keep key generation explicit.
        }
      }
      if (receiptFile && id && before && receiptKey !== String(before.receipt_key ?? before.receiptKey ?? "") && receiptBucket()) {
        const oldKey = String(before.receipt_key ?? before.receiptKey ?? "");
        if (oldKey) await receiptBucket()!.delete(oldKey);
      }
      await audit(user, id ? "update" : "create", "expense", savedId, `${id ? "Updated" : "Added"} expense${vendor ? ` at ${vendor}` : ""} for ${job.name}`, { jobId, purchaseDate, vendor, category, amount, salesTax, reviewed, hasReceipt: Boolean(receiptKey) });
      return json({ ok: true, id: savedId });
    }

    if (action === "deleteExpense") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const id = Number(body.id ?? 0);
      const before = await database().prepare(`SELECT id, vendor, receipt_key AS receiptKey FROM expenses WHERE id = ?`).bind(id).first<{ id: number; vendor: string; receiptKey: string }>();
      if (!before) return json({ error: "Expense not found." }, 404);
      await database().prepare(`DELETE FROM expenses WHERE id = ?`).bind(id).run();
      if (before.receiptKey && receiptBucket()) await receiptBucket()!.delete(before.receiptKey);
      await audit(user, "delete", "expense", id, `Removed expense${before.vendor ? ` at ${before.vendor}` : ""}`, { before });
      return json({ ok: true });
    }

    if (action === "requestTimeOff") {
      if (user.role !== "employee") return json({ error: "Employee access required to submit a request." }, 403);
      const startDate = String(body.startDate ?? "");
      const endDate = String(body.endDate ?? "");
      const note = String(body.note ?? "").trim().slice(0, 500);
      if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) {
        return json({ error: "Choose a valid start and end date." }, 400);
      }
      if (startDate < todayEastern()) return json({ error: "Time-off requests must start today or later." }, 400);
      const length = Math.round((new Date(`${endDate}T12:00:00Z`).getTime() - new Date(`${startDate}T12:00:00Z`).getTime()) / 86400000) + 1;
      if (length > 60) return json({ error: "A single request can cover up to 60 days." }, 400);
      const overlap = await database().prepare(
        `SELECT id FROM time_off_requests WHERE user_id = ? AND status IN ('pending', 'approved') AND NOT (end_date < ? OR start_date > ?) LIMIT 1`,
      ).bind(user.id, startDate, endDate).first();
      if (overlap) return json({ error: "You already have a pending or approved request during those dates." }, 409);
      await database().prepare(
        `INSERT INTO time_off_requests (user_id, start_date, end_date, note, status, requested_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      ).bind(user.id, startDate, endDate, note, now, now).run();
      const saved = await database().prepare(
        `SELECT id FROM time_off_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      ).bind(user.id).first<{ id: number }>();
      const adminRows = (await database().prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id`).all()).results as Array<{ id: number }>;
      const requestUrl = new URL(`/?tab=timeoff&request=${saved?.id ?? ""}&month=${startDate.slice(0, 7)}`, request.url).toString();
      const push = await sendPush(
        adminRows.map((item) => Number(item.id)),
        "New time-off request",
        `${user.name} requested ${dateRangeLabel(startDate, endDate)}.`,
        requestUrl,
        saved?.id ? [
          { id: "approve", text: "Approve", url: new URL(`/?tab=timeoff&request=${saved.id}&decision=approved&month=${startDate.slice(0, 7)}`, request.url).toString() },
          { id: "deny", text: "Deny", url: new URL(`/?tab=timeoff&request=${saved.id}&decision=denied&month=${startDate.slice(0, 7)}`, request.url).toString() },
        ] : [],
      );
      await audit(user, "request", "time_off", saved?.id ?? "", `Requested time off for ${dateRangeLabel(startDate, endDate)}`, { startDate, endDate, note, pushSent: push.sent });
      return json({ ok: true, pushSent: push.sent });
    }

    if (action === "cancelTimeOff") {
      if (user.role !== "employee") return json({ error: "Employee access required." }, 403);
      const id = Number(body.id);
      const before = await database().prepare(
        `SELECT r.id, r.start_date AS startDate, r.end_date AS endDate, r.status FROM time_off_requests r WHERE r.id = ? AND r.user_id = ?`,
      ).bind(id, user.id).first<{ id: number; startDate: string; endDate: string; status: string }>();
      if (!before || before.status !== "pending") return json({ error: "Only a pending request can be cancelled." }, 409);
      await database().prepare(`UPDATE time_off_requests SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(now, id).run();
      const adminRows = (await database().prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id`).all()).results as Array<{ id: number }>;
      await sendPush(
        adminRows.map((item) => Number(item.id)),
        "Time-off request cancelled",
        `${user.name} cancelled ${dateRangeLabel(before.startDate, before.endDate)}.`,
        new URL(`/?tab=timeoff&request=${id}&month=${before.startDate.slice(0, 7)}`, request.url).toString(),
      );
      await audit(user, "cancel", "time_off", id, `Cancelled time off for ${dateRangeLabel(before.startDate, before.endDate)}`, { before });
      return json({ ok: true });
    }

    if (action === "reviewTimeOff") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const id = Number(body.id);
      const decision = body.decision === "approved" ? "approved" : body.decision === "denied" ? "denied" : "";
      const reviewNote = String(body.reviewNote ?? "").trim().slice(0, 500);
      if (!id || !decision) return json({ error: "Choose approve or deny." }, 400);
      const before = await database().prepare(
        `SELECT r.id, r.user_id AS userId, u.name AS userName, r.start_date AS startDate, r.end_date AS endDate, r.note, r.status FROM time_off_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      ).bind(id).first<{ id: number; userId: number; userName: string; startDate: string; endDate: string; note: string; status: string }>();
      if (!before || before.status !== "pending") return json({ error: "That request is no longer pending." }, 409);
      const push = pushConfig();
      const reminderQueued = decision === "approved" && Boolean(push.appId && push.apiKey);
      await database().prepare(
        `UPDATE time_off_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ?, reminder_sent_at = NULL WHERE id = ?`,
      ).bind(decision, user.id, reviewNote, now, now, id).run();
      const range = dateRangeLabel(before.startDate, before.endDate);
      const employeePush = await sendPush(
        [before.userId],
        decision === "approved" ? "Time off approved" : "Time-off request denied",
        decision === "approved" ? `Your time off for ${range} was approved.` : `Your time-off request for ${range} was denied.`,
        new URL(`/?tab=timeoff&request=${id}&month=${before.startDate.slice(0, 7)}`, request.url).toString(),
      );
      await audit(user, decision === "approved" ? "approve" : "deny", "time_off", id, `${decision === "approved" ? "Approved" : "Denied"} ${before.userName}'s time off for ${range}`, { before, reviewNote, reminderQueued, employeePushSent: employeePush.sent });
      return json({ ok: true, reminderQueued, employeePushSent: employeePush.sent });
    }

    if (action === "saveEntry") {
      const targetId = user.role === "admin" ? Number(body.userId) : user.id;
      const jobId = Number(body.jobId);
      const workDate = String(body.workDate ?? "");
      const hours = Number(body.hours) || 0;
      const note = String(body.note ?? "").trim().slice(0, 500);
      const flagged = Boolean(body.flagged);
      const flagReason = flagged ? String(body.flagReason ?? "").trim().slice(0, 500) : "";
      if (!targetId || !jobId || !validDate(workDate)) return json({ error: "The time entry is incomplete." }, 400);
      if (!Number.isFinite(hours) || hours < 0 || hours > 24) return json({ error: "Hours for one job must be between 0 and 24." }, 400);
      const [target, job] = await Promise.all([
        user.role === "admin"
          ? database().prepare(`SELECT id FROM users WHERE id = ? AND active = 1 AND (role = 'employee' OR id = ?)`).bind(targetId, user.id).first()
          : database().prepare(`SELECT id FROM users WHERE id = ? AND role = 'employee' AND active = 1`).bind(targetId).first(),
        user.role === "admin"
          ? database().prepare(`SELECT id FROM jobs WHERE id = ?`).bind(jobId).first()
          : database().prepare(`SELECT id FROM jobs WHERE id = ? AND active = 1`).bind(jobId).first(),
      ]);
      if (!target || !job) return json({ error: "That employee or job is no longer active." }, 409);
      if (hours === 0 && !note && !flagged) {
        const before = await database().prepare(
          `SELECT id, hours, note, flagged, flag_reason AS flagReason FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
        ).bind(targetId, jobId, workDate).first();
        await database().prepare(
          `DELETE FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
        ).bind(targetId, jobId, workDate).run();
        if (before) await audit(user, "delete", "time_entry", String(before.id), `Removed time for ${workDate}`, { userId: targetId, jobId, before });
        await refreshJobMismatchReviews(request);
        return json({ ok: true, deleted: true });
      }
      const otherHours = await database().prepare(
        `SELECT COALESCE(SUM(hours), 0) AS hours FROM time_entries WHERE user_id = ? AND work_date = ? AND job_id <> ?`,
      ).bind(targetId, workDate, jobId).first<{ hours: number }>();
      const warnings = [
        ...(workDate > todayEastern() ? ["This entry is dated in the future."] : []),
        ...(Number(otherHours?.hours ?? 0) + hours > 24 ? [`This would make the day's total ${(Number(otherHours?.hours ?? 0) + hours).toFixed(2)} hours.`] : []),
      ];
      if (warnings.length && !body.warningsAccepted) {
        return json({ error: `${warnings.join(" ")} Confirm the warning in the time-entry window to save it.` }, 409);
      }
      const before = await database().prepare(
        `SELECT id, hours, note, flagged, flag_reason AS flagReason FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
      ).bind(targetId, jobId, workDate).first<{ id: number } & Record<string, unknown>>();
      await database().prepare(
        `INSERT INTO time_entries (user_id, job_id, work_date, hours, note, flagged, flag_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, job_id, work_date) DO UPDATE SET hours=excluded.hours, note=excluded.note, flagged=excluded.flagged, flag_reason=excluded.flag_reason, updated_at=excluded.updated_at`,
      ).bind(targetId, jobId, workDate, hours, note, flagged ? 1 : 0, flagReason, now).run();
      const saved = await database().prepare(
        `SELECT id, hours, note, flagged, flag_reason AS flagReason FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
      ).bind(targetId, jobId, workDate).first<{ id: number } & Record<string, unknown>>();
      if (saved) await audit(user, before ? "update" : "create", "time_entry", saved.id, `${before ? "Changed" : "Added"} ${hours.toFixed(2)} hours for ${workDate}`, { userId: targetId, jobId, before: before ?? null, after: saved });
      await refreshJobMismatchReviews(request);
      return json({ ok: true });
    }

    if (action === "moveEntry") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const entryId = Number(body.entryId);
      const jobId = Number(body.jobId);
      const before = await database().prepare(
        `SELECT t.id, t.user_id AS userId, t.job_id AS jobId, t.work_date AS workDate, t.hours, j.name AS jobName, u.name AS userName
         FROM time_entries t JOIN jobs j ON j.id = t.job_id JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
      ).bind(entryId).first<{ id: number; userId: number; jobId: number; workDate: string; hours: number; jobName: string; userName: string }>();
      const destination = await database().prepare(`SELECT id, name FROM jobs WHERE id = ?`).bind(jobId).first<{ id: number; name: string }>();
      if (!before || !destination) return json({ error: "That time entry or destination job no longer exists." }, 404);
      if (before.jobId === destination.id) return json({ error: "Choose a different job." }, 400);
      const existing = await database().prepare(
        `SELECT id FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
      ).bind(before.userId, destination.id, before.workDate).first();
      if (existing) return json({ error: `${before.userName} already has time on ${destination.name} for that day. Edit that entry first.` }, 409);
      await database().prepare(`UPDATE time_entries SET job_id = ?, updated_at = ? WHERE id = ?`).bind(destination.id, now, entryId).run();
      await audit(user, "move", "time_entry", entryId, `Moved ${before.hours.toFixed(2)} hours from ${before.jobName} to ${destination.name}`, { before, after: { ...before, jobId: destination.id, jobName: destination.name } });
      await refreshJobMismatchReviews(request);
      return json({ ok: true });
    }

    if (action === "resolveJobMismatch") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const reviewId = Number(body.reviewId);
      const decision = String(body.decision ?? "");
      if (!reviewId || !["jobA", "jobB", "other", "separate"].includes(decision)) {
        return json({ error: "Choose how these hours should be handled." }, 400);
      }
      const review = await database().prepare(
        `SELECT r.id, r.status, r.start_date AS startDate, r.end_date AS endDate, r.entry_ids_a AS entryIdsA,
           r.entry_ids_b AS entryIdsB, r.job_a_id AS jobAId, ja.name AS jobAName, r.job_b_id AS jobBId,
           jb.name AS jobBName, ua.name AS userAName, ub.name AS userBName
         FROM job_mismatch_reviews r
         JOIN jobs ja ON ja.id = r.job_a_id
         JOIN jobs jb ON jb.id = r.job_b_id
         JOIN users ua ON ua.id = r.user_a_id
         JOIN users ub ON ub.id = r.user_b_id
         WHERE r.id = ?`,
      ).bind(reviewId).first<{
        id: number; status: string; startDate: string; endDate: string; entryIdsA: string; entryIdsB: string;
        jobAId: number; jobAName: string; jobBId: number; jobBName: string; userAName: string; userBName: string;
      }>();
      if (!review || review.status !== "pending") return json({ error: "That mismatch is no longer pending." }, 409);
      const range = dateRangeLabel(review.startDate, review.endDate);
      if (decision === "separate") {
        await database().prepare(
          `UPDATE job_mismatch_reviews SET status = 'separate', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
        ).bind(user.id, now, now, review.id).run();
        await audit(user, "dismiss", "job_mismatch", review.id, `Confirmed ${review.userAName} and ${review.userBName} worked separate jobs for ${range}`, { review, decision });
        return json({ ok: true, moved: 0 });
      }

      const requestedJobId = decision === "jobA" ? Number(review.jobAId) : decision === "jobB" ? Number(review.jobBId) : Number(body.jobId);
      const destination = await database().prepare(`SELECT id, name FROM jobs WHERE id = ?`).bind(requestedJobId).first<{ id: number; name: string }>();
      if (!destination) return json({ error: "Choose a valid destination job." }, 400);
      const entryIds = [...new Set([...parsedNumberArray(review.entryIdsA), ...parsedNumberArray(review.entryIdsB)])].slice(0, 100);
      if (!entryIds.length) return json({ error: "The affected time entries could not be found." }, 409);
      const placeholders = entryIds.map(() => "?").join(",");
      const entries = (await database().prepare(
        `SELECT t.id, t.user_id AS userId, u.name AS userName, t.job_id AS jobId, j.name AS jobName,
           t.work_date AS workDate, t.hours
         FROM time_entries t JOIN users u ON u.id = t.user_id JOIN jobs j ON j.id = t.job_id
         WHERE t.id IN (${placeholders}) ORDER BY t.work_date, t.id`,
      ).bind(...entryIds).all()).results as Array<{
        id: number; userId: number; userName: string; jobId: number; jobName: string; workDate: string; hours: number;
      }>;
      if (entries.length !== entryIds.length || entries.some((entry) => ![Number(review.jobAId), Number(review.jobBId)].includes(Number(entry.jobId)))) {
        await database().prepare(`UPDATE job_mismatch_reviews SET status = 'stale', updated_at = ? WHERE id = ?`).bind(now, review.id).run();
        return json({ error: "Those hours changed after this review was created. HazenTime removed the outdated suggestion." }, 409);
      }
      const moving = entries.filter((entry) => Number(entry.jobId) !== destination.id);
      for (const entry of moving) {
        const collision = await database().prepare(
          `SELECT id FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ? AND id <> ?`,
        ).bind(entry.userId, destination.id, entry.workDate, entry.id).first();
        if (collision) {
          return json({ error: `${entry.userName} already has time on ${destination.name} for ${entry.workDate}. Review that day before applying this suggestion.` }, 409);
        }
      }
      await database().batch([
        ...moving.map((entry) => database().prepare(`UPDATE time_entries SET job_id = ?, updated_at = ? WHERE id = ?`).bind(destination.id, now, entry.id)),
        database().prepare(
          `UPDATE job_mismatch_reviews SET status = 'corrected', selected_job_id = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
        ).bind(destination.id, user.id, now, now, review.id),
      ]);
      await audit(user, "correct", "job_mismatch", review.id, `Moved ${moving.length} ${moving.length === 1 ? "entry" : "entries"} to ${destination.name} for ${range}`, {
        review,
        destination,
        movedEntries: moving,
      });
      await refreshJobMismatchReviews(request);
      return json({ ok: true, moved: moving.length, destination: destination.name });
    }

    if (action === "resolve") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      await database().prepare(`UPDATE time_entries SET resolution = ?, resolved = ?, updated_at = ? WHERE id = ?`)
        .bind(String(body.resolution ?? "").trim().slice(0, 500), body.resolved ? 1 : 0, now, Number(body.entryId)).run();
      await audit(user, "resolve", "time_entry", Number(body.entryId), body.resolved ? "Marked flagged entry resolved" : "Updated flagged-entry resolution", { resolution: String(body.resolution ?? "").trim().slice(0, 500), resolved: Boolean(body.resolved) });
      return json({ ok: true });
    }

    if (action === "setPaid") {
      const targetId = user.role === "admin" ? Number(body.userId) : user.id;
      const weekStart = sundayOf(body.weekStart);
      if (user.role === "admin") {
        const paid = Boolean(body.paid);
        const checkNumber = String(body.checkNumber ?? "").trim().slice(0, 40);
        const paymentMethod = String(body.paymentMethod ?? "").trim().slice(0, 40);
        const requestedDate = String(body.paymentDate ?? "");
        const paymentDate = paid ? requestedDate || todayEastern() : requestedDate;
        if (paymentDate && !validDate(paymentDate)) return json({ error: "Choose a valid payment date." }, 400);
        await database().prepare(
          `INSERT INTO pay_weeks (user_id, week_start, paid, received, payment_date, payment_method, check_number, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT(user_id, week_start) DO UPDATE SET paid=excluded.paid, payment_date=excluded.payment_date, payment_method=excluded.payment_method, check_number=excluded.check_number, updated_at=excluded.updated_at`,
        ).bind(targetId, weekStart, paid ? 1 : 0, paymentDate, paymentMethod, checkNumber, now).run();
        await audit(user, "payment_issued", "pay_week", `${targetId}:${weekStart}`, paid ? `Recorded payment issued for week of ${weekStart}` : `Marked payment not issued for week of ${weekStart}`, { userId: targetId, weekStart, paid, paymentDate, paymentMethod, checkNumber });
      } else {
        const received = Boolean(body.received);
        await database().prepare(
          `INSERT INTO pay_weeks (user_id, week_start, paid, received, payment_date, payment_method, check_number, updated_at) VALUES (?, ?, 0, ?, '', '', '', ?)
           ON CONFLICT(user_id, week_start) DO UPDATE SET received=excluded.received, updated_at=excluded.updated_at`,
        ).bind(targetId, weekStart, received ? 1 : 0, now).run();
        await audit(user, "payment_received", "pay_week", `${targetId}:${weekStart}`, received ? `Confirmed payment received for week of ${weekStart}` : `Removed payment-received confirmation for week of ${weekStart}`, { userId: targetId, weekStart, received });
      }
      return json({ ok: true });
    }

    if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);

    if (action === "changeAdminPin") {
      const currentPin = String(body.currentPin ?? "");
      const newPin = String(body.newPin ?? "");
      if (!/^\d{6}$/.test(currentPin) || !/^\d{6}$/.test(newPin)) {
        return json({ error: "Enter your current PIN and a new 6-digit PIN." }, 400);
      }
      if (currentPin === newPin) return json({ error: "Choose a different PIN." }, 400);
      const admin = await database().prepare(
        `SELECT pin_hash AS pinHash, pin_salt AS pinSalt FROM users WHERE id = ? AND role = 'admin'`,
      ).bind(user.id).first<{ pinHash: string; pinSalt: string }>();
      if (!admin || (await pinHash(currentPin, admin.pinSalt)) !== admin.pinHash) {
        return json({ error: "The current PIN is incorrect." }, 401);
      }
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await database().prepare(`UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ? AND role = 'admin'`)
        .bind(await pinHash(newPin, salt), salt, user.id).run();
      await audit(user, "pin_change", "administrator", user.id, `Changed administrator PIN for ${user.name}`, { pinChanged: true });
      return json({ ok: true });
    }

    if (action === "saveEmployee") {
      const id = Number(body.id);
      const name = String(body.name ?? "").trim();
      const phone = String(body.phone ?? "").trim().slice(0, 30);
      const hourlyRate = Math.max(0, Number(body.hourlyRate) || 0);
      const pin = String(body.pin ?? "");
      const effectiveDate = String(body.effectiveDate ?? todayEastern());
      if (!name || (!id && !/^\d{4,6}$/.test(pin))) return json({ error: "Name and a 4–6 digit PIN are required." }, 400);
      let rateChanged = !id;
      if (id) {
        const before = await database().prepare(`SELECT hourly_rate AS hourlyRate FROM users WHERE id = ? AND role = 'employee'`).bind(id).first<{ hourlyRate: number }>();
        if (!before) return json({ error: "Employee not found." }, 404);
        rateChanged = Math.abs(Number(before.hourlyRate) - hourlyRate) > 0.0001;
        if (rateChanged && (!validDate(effectiveDate) || effectiveDate > todayEastern())) return json({ error: "Choose an effective date of today or earlier for the new rate." }, 400);
        if (pin) {
          if (!/^\d{4,6}$/.test(pin)) return json({ error: "PIN must be 4–6 digits." }, 400);
          const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
          await database().prepare(`UPDATE users SET name=?, phone=?, hourly_rate=?, pin_hash=?, pin_salt=? WHERE id=? AND role='employee'`)
            .bind(name, phone, hourlyRate, await pinHash(pin, salt), salt, id).run();
        } else {
          await database().prepare(`UPDATE users SET name=?, phone=?, hourly_rate=? WHERE id=? AND role='employee'`)
            .bind(name, phone, hourlyRate, id).run();
        }
      } else {
        if (!validDate(effectiveDate) || effectiveDate > todayEastern()) return json({ error: "Choose a starting date of today or earlier for the pay rate." }, 400);
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        await database().prepare(`INSERT INTO users (name, phone, role, pin_hash, pin_salt, hourly_rate, created_at) VALUES (?, ?, 'employee', ?, ?, ?, ?)`)
          .bind(name, phone, await pinHash(pin, salt), salt, hourlyRate, now).run();
      }
      const saved = id ? { id } : await database().prepare(`SELECT id FROM users WHERE role='employee' ORDER BY id DESC LIMIT 1`).first<{ id: number }>();
      if (saved?.id && rateChanged) {
        await database().prepare(
          `INSERT INTO employee_pay_rates (user_id, rate, effective_from, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, effective_from) DO UPDATE SET rate=excluded.rate, created_at=excluded.created_at`,
        ).bind(saved.id, hourlyRate, effectiveDate, now).run();
        await database().prepare(
          `UPDATE users SET hourly_rate = (SELECT rate FROM employee_pay_rates WHERE user_id = ? ORDER BY effective_from DESC, id DESC LIMIT 1) WHERE id = ?`,
        ).bind(saved.id, saved.id).run();
      }
      await audit(user, id ? "update" : "create", "employee", id || saved?.id || "", rateChanged ? `${id ? "Updated" : "Added"} ${name} at ${hourlyRate.toFixed(2)}/hr effective ${effectiveDate}` : `${id ? "Updated" : "Added"} employee ${name}`, { name, phone, hourlyRate, effectiveDate: rateChanged ? effectiveDate : undefined, pinChanged: Boolean(pin) });
      return json({ ok: true });
    }

    if (action === "archiveEmployee" || action === "deleteEmployee") {
      const id = Number(body.id);
      const before = await database().prepare(`SELECT id, name, phone, hourly_rate AS hourlyRate, active FROM users WHERE id = ? AND role = 'employee'`).bind(id).first<{ name: string } & Record<string, unknown>>();
      if (!before) return json({ error: "Employee not found." }, 404);
      await database().batch([
        database().prepare(`UPDATE users SET active = 0 WHERE id = ? AND role = 'employee'`).bind(id),
        database().prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
        database().prepare(`DELETE FROM login_attempts WHERE user_id = ?`).bind(id),
      ]);
      await audit(user, "archive", "employee", id, `Removed ${before.name} from active employees while preserving all records`, { before });
      return json({ ok: true });
    }

    if (action === "restoreEmployee") {
      const id = Number(body.id);
      const before = await database().prepare(`SELECT id, name, active FROM users WHERE id = ? AND role = 'employee'`).bind(id).first<{ name: string; active: number }>();
      if (!before) return json({ error: "Employee not found." }, 404);
      await database().prepare(`UPDATE users SET active = 1 WHERE id = ? AND role = 'employee'`).bind(id).run();
      await audit(user, "restore", "employee", id, `Restored ${before.name} to active employees`, { before });
      return json({ ok: true });
    }

    if (action === "saveJob") {
      const id = Number(body.id);
      const name = String(body.name ?? "").trim();
      if (!name) return json({ error: "Job name is required." }, 400);
      if (id) await database().prepare(`UPDATE jobs SET name=? WHERE id=?`).bind(name, id).run();
      else await database().prepare(`INSERT INTO jobs (name, created_at) VALUES (?, ?)`).bind(name, now).run();
      const saved = id ? { id } : await database().prepare(`SELECT id FROM jobs ORDER BY id DESC LIMIT 1`).first<{ id: number }>();
      await audit(user, id ? "update" : "create", "job", id || saved?.id || "", `${id ? "Renamed" : "Added"} job ${name}`, { name });
      return json({ ok: true });
    }

    if (action === "completeJob" || action === "reopenJob") {
      const id = Number(body.id);
      const active = action === "reopenJob" ? 1 : 0;
      const before = await database().prepare(`SELECT id, name, active FROM jobs WHERE id = ?`).bind(id).first<{ id: number; name: string; active: number }>();
      if (!before) return json({ error: "Job not found." }, 404);
      await database().prepare(`UPDATE jobs SET active = ? WHERE id = ?`).bind(active, id).run();
      await audit(user, active ? "reopen" : "complete", "job", id, `${active ? "Reopened" : "Completed"} job ${before.name}`, { before, after: { ...before, active } });
      return json({ ok: true });
    }

    if (action === "deleteJob") {
      const id = Number(body.id);
      const used = await database().prepare(`SELECT COUNT(*) AS count FROM time_entries WHERE job_id=?`).bind(id).first<{ count: number }>();
      if (used?.count) return json({ error: "This job has time entries and cannot be removed." }, 409);
      const before = await database().prepare(`SELECT id, name FROM jobs WHERE id=?`).bind(id).first<{ name: string }>();
      if (before) await audit(user, "delete", "job", id, `Removed job ${before.name}`, { before });
      await database().prepare(`DELETE FROM jobs WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("Time card change failed", error);
    return json({ error: "That change could not be saved." }, 500);
  }
}
