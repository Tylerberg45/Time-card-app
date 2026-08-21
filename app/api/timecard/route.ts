type Payload = Record<string, unknown>;
type SessionUser = { id: number; name: string; role: "admin" | "employee" };
type PushResult = { sent: boolean; id?: string };

declare const __TIME_CARD_BUILD_ID__: string;

const COOKIE = "timecard_session";
const encoder = new TextEncoder();

function database() {
  const db = (globalThis as typeof globalThis & { __TIME_CARD_DB?: D1Database }).__TIME_CARD_DB;
  if (!db) throw new Error("The time card database is unavailable.");
  return db;
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

async function ensureSchema() {
  const db = database();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, hourly_rate REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS employee_pay_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, rate REAL NOT NULL DEFAULT 0, effective_from TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS employee_pay_rate_user_date ON employee_pay_rates(user_id, effective_from)`,
    `INSERT OR IGNORE INTO employee_pay_rates (user_id, rate, effective_from, created_at) SELECT id, hourly_rate, substr(created_at, 1, 10), created_at FROM users WHERE role = 'employee'`,
    `CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS time_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL REFERENCES jobs(id), work_date TEXT NOT NULL, hours REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', flagged INTEGER NOT NULL DEFAULT 0, flag_reason TEXT NOT NULL DEFAULT '', resolution TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS entry_user_job_date ON time_entries(user_id, job_id, work_date)`,
    `CREATE TABLE IF NOT EXISTS pay_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0, check_number TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS pay_week_user_start ON pay_weeks(user_id, week_start)`,
    `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_name TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log(created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS time_off_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, start_date TEXT NOT NULL, end_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, review_note TEXT NOT NULL DEFAULT '', requested_at TEXT NOT NULL, reviewed_at TEXT, updated_at TEXT NOT NULL, reminder_notification_id TEXT, reminder_sent_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS time_off_user_dates ON time_off_requests(user_id, start_date, end_date)`,
    `CREATE INDEX IF NOT EXISTS time_off_status_start ON time_off_requests(status, start_date)`,
  ];
  await db.batch(statements.map((sql) => db.prepare(sql)));
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
    `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
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
  const jobs = (await database().prepare(`SELECT id, name FROM jobs WHERE active = 1 ORDER BY name`).all()).results;
  const employees = user.role === "admin"
    ? (await database().prepare(`SELECT id, name, phone, hourly_rate AS hourlyRate FROM users WHERE role = 'employee' ORDER BY name`).all()).results
    : [];
  const firstEmployeeId = user.role === "admin" && employees.length
    ? Number((employees[0] as { id: number }).id)
    : user.id;
  const targetId = user.role === "admin" && Number(selectedId) ? Number(selectedId) : firstEmployeeId;
  const target = await database().prepare(
    `SELECT id, name, phone, hourly_rate AS hourlyRate FROM users WHERE id = ? AND role = 'employee'`,
  ).bind(targetId).first();
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
    ? await database().prepare(`SELECT paid, check_number AS checkNumber FROM pay_weeks WHERE user_id = ? AND week_start = ?`).bind(targetId, weekStart).first<{ paid: number; checkNumber: string }>()
    : null;
  const pending = user.role === "admin"
    ? await database().prepare(`SELECT COUNT(*) AS count FROM time_off_requests WHERE status = 'pending'`).first<{ count: number }>()
    : await database().prepare(`SELECT COUNT(*) AS count FROM time_off_requests WHERE user_id = ? AND status = 'pending'`).bind(user.id).first<{ count: number }>();
  const push = pushConfig();
  return {
    configured: true,
    user,
    weekStart,
    weekEnd,
    jobs,
    employees,
    target,
    entries,
    paid: Boolean(pay?.paid),
    checkNumber: pay?.checkNumber ?? "",
    pendingTimeOffCount: Number(pending?.count ?? 0),
    syncToken: await latestSyncToken(),
    push: user.role === "admin" && push.appId
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
      `SELECT week_start AS weekStart, paid, check_number AS checkNumber
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
      const people = (await database().prepare(`SELECT id, name FROM users WHERE role = 'employee' ORDER BY name`).all()).results;
      const admins = (await database().prepare(`SELECT id, name FROM users WHERE role = 'admin' ORDER BY name`).all()).results;
      return json({ configured: true, authenticated: false, employees: people, admins, syncToken: await latestSyncToken() });
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
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      const employeeId = Number(url.searchParams.get("employeeId"));
      const startDate = url.searchParams.get("startDate") ?? "";
      const endDate = url.searchParams.get("endDate") ?? "";
      if (!employeeId || !validDate(startDate) || !validDate(endDate) || endDate < startDate) {
        return json({ error: "Choose an employee and a valid date range." }, 400);
      }
      const report = await payReport(employeeId, startDate, endDate);
      return report ? json(report) : json({ error: "Employee not found." }, 404);
    }
    const download = url.searchParams.get("download");
    if (download) {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      if (download === "csv") {
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
             COALESCE(p.paid, 0) AS paid, COALESCE(p.check_number, '') AS checkNumber
           FROM time_entries t
           JOIN users u ON u.id = t.user_id
           JOIN jobs j ON j.id = t.job_id
           LEFT JOIN pay_weeks p ON p.user_id = t.user_id AND p.week_start = ?
           WHERE t.work_date BETWEEN ? AND ? AND (? = 0 OR t.user_id = ?)
           ORDER BY u.name, t.work_date, j.name`,
        ).bind(weekStart, weekStart, weekEnd, employeeId, employeeId).all()).results as Record<string, unknown>[];
        const header = ["Employee", "Date", "Job", "Hours", "Hourly Rate", "Entry Pay", "Note", "Flagged", "Flag Reason", "Resolved", "Resolution", "Paid", "Check Number"];
        const lines = rows.map((row) => [
          row.employee, row.workDate, row.job, Number(row.hours).toFixed(2), Number(row.hourlyRate).toFixed(2),
          (Number(row.hours) * Number(row.hourlyRate)).toFixed(2), row.note,
          row.flagged ? "Yes" : "No", row.flagReason, row.resolved ? "Yes" : "No", row.resolution, row.paid ? "Yes" : "No", row.checkNumber,
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
        const employeeId = Number(url.searchParams.get("employeeId"));
        const startDate = url.searchParams.get("startDate") ?? "";
        const endDate = url.searchParams.get("endDate") ?? "";
        if (!employeeId || !validDate(startDate) || !validDate(endDate) || endDate < startDate) {
          return json({ error: "Choose an employee and a valid date range." }, 400);
        }
        const report = await payReport(employeeId, startDate, endDate);
        if (!report) return json({ error: "Employee not found." }, 404);
        const paidByWeek = new Map((report.paidWeeks as Array<Record<string, unknown>>).map((item) => [String(item.weekStart), item]));
        const header = ["Employee", "Date", "Week Starting", "Job", "Hours", "Hourly Rate Used", "Calculated Gross Pay", "Paid", "Check Number"];
        const lines = (report.entries as Array<Record<string, unknown>>).map((row) => {
          const weekStart = sundayOf(row.workDate);
          const payment = paidByWeek.get(weekStart);
          return [
            report.employee.name, row.workDate, weekStart, row.job, Number(row.hours).toFixed(2), Number(row.hourlyRate).toFixed(2),
            (Number(row.hours) * Number(row.hourlyRate)).toFixed(2), payment?.paid ? "Yes" : "No", payment?.checkNumber ?? "",
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
        const [users, jobs, entries, payWeeks, payRateHistory, timeOff, history] = await Promise.all([
          database().prepare(`SELECT id, name, phone, role, hourly_rate AS hourlyRate, created_at AS createdAt FROM users ORDER BY id`).all(),
          database().prepare(`SELECT id, name, active, created_at AS createdAt FROM jobs ORDER BY id`).all(),
          database().prepare(`SELECT id, user_id AS userId, job_id AS jobId, work_date AS workDate, hours, note, flagged, flag_reason AS flagReason, resolution, resolved, updated_at AS updatedAt FROM time_entries ORDER BY work_date, id`).all(),
          database().prepare(`SELECT id, user_id AS userId, week_start AS weekStart, paid, check_number AS checkNumber, updated_at AS updatedAt FROM pay_weeks ORDER BY week_start, id`).all(),
          database().prepare(`SELECT id, user_id AS userId, rate, effective_from AS effectiveFrom, created_at AS createdAt FROM employee_pay_rates ORDER BY user_id, effective_from, id`).all(),
          database().prepare(`SELECT id, user_id AS userId, start_date AS startDate, end_date AS endDate, note, status, reviewed_by AS reviewedBy, review_note AS reviewNote, requested_at AS requestedAt, reviewed_at AS reviewedAt, updated_at AS updatedAt, reminder_sent_at AS reminderSentAt FROM time_off_requests ORDER BY start_date, id`).all(),
          database().prepare(`SELECT id, actor_id AS actorId, actor_name AS actorName, action, target_type AS targetType, target_id AS targetId, summary, details, created_at AS createdAt FROM audit_log ORDER BY id`).all(),
        ]);
        const backup = JSON.stringify({
          format: "time-card-backup-v2",
          exportedAt: new Date().toISOString(),
          users: users.results, jobs: jobs.results, timeEntries: entries.results, payWeeks: payWeeks.results, payRateHistory: payRateHistory.results, timeOffRequests: timeOff.results, auditLog: history.results,
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
    const body = (await request.json()) as Payload;
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
      const person = await database().prepare(`SELECT id, name, role, pin_hash AS pinHash, pin_salt AS pinSalt FROM users WHERE id = ?`)
        .bind(id).first<SessionUser & { pinHash: string; pinSalt: string }>();
      if (!person || (await pinHash(pin, person.pinSalt)) !== person.pinHash) return json({ error: "That PIN is incorrect." }, 401);
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
      const adminRows = (await database().prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id`).all()).results as Array<{ id: number }>;
      const push = await sendPush(
        adminRows.map((item) => Number(item.id)),
        "New time-off request",
        `${user.name} requested ${dateRangeLabel(startDate, endDate)}.`,
        new URL("/?tab=timeoff", request.url).toString(),
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
      const adminRows = (await database().prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id`).all()).results as Array<{ id: number }>;
      await sendPush(
        adminRows.map((item) => Number(item.id)),
        "Time-off request cancelled",
        `${user.name} cancelled ${dateRangeLabel(before.startDate, before.endDate)}.`,
        new URL("/?tab=timeoff", request.url).toString(),
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
      await audit(user, decision === "approved" ? "approve" : "deny", "time_off", id, `${decision === "approved" ? "Approved" : "Denied"} ${before.userName}'s time off for ${dateRangeLabel(before.startDate, before.endDate)}`, { before, reviewNote, reminderQueued });
      return json({ ok: true, reminderQueued });
    }

    if (action === "saveEntry") {
      const targetId = user.role === "admin" ? Number(body.userId) : user.id;
      const jobId = Number(body.jobId);
      const workDate = String(body.workDate ?? "");
      const hours = Math.max(0, Math.min(24, Number(body.hours) || 0));
      const note = String(body.note ?? "").trim().slice(0, 500);
      const flagged = Boolean(body.flagged);
      const flagReason = flagged ? String(body.flagReason ?? "").trim().slice(0, 500) : "";
      if (!targetId || !jobId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return json({ error: "The time entry is incomplete." }, 400);
      if (hours === 0 && !note && !flagged) {
        const before = await database().prepare(
          `SELECT id, hours, note, flagged, flag_reason AS flagReason FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
        ).bind(targetId, jobId, workDate).first();
        await database().prepare(
          `DELETE FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
        ).bind(targetId, jobId, workDate).run();
        if (before) await audit(user, "delete", "time_entry", String(before.id), `Removed time for ${workDate}`, { userId: targetId, jobId, before });
        return json({ ok: true, deleted: true });
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
      return json({ ok: true });
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
      const checkNumber = user.role === "admin" ? String(body.checkNumber ?? "").trim().slice(0, 40) : null;
      if (user.role === "admin") {
        await database().prepare(
          `INSERT INTO pay_weeks (user_id, week_start, paid, check_number, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, week_start) DO UPDATE SET paid=excluded.paid, check_number=excluded.check_number, updated_at=excluded.updated_at`,
        ).bind(targetId, weekStart, body.paid ? 1 : 0, checkNumber, now).run();
      } else {
        await database().prepare(
          `INSERT INTO pay_weeks (user_id, week_start, paid, check_number, updated_at) VALUES (?, ?, ?, '', ?)
           ON CONFLICT(user_id, week_start) DO UPDATE SET paid=excluded.paid, updated_at=excluded.updated_at`,
        ).bind(targetId, weekStart, body.paid ? 1 : 0, now).run();
      }
      await audit(user, "paid_status", "pay_week", `${targetId}:${weekStart}`, body.paid ? `Updated payment record for week of ${weekStart}` : `Marked week of ${weekStart} unpaid`, { userId: targetId, weekStart, paid: Boolean(body.paid), checkNumber: checkNumber ?? undefined });
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

    if (action === "deleteEmployee") {
      const id = Number(body.id);
      const before = await database().prepare(`SELECT id, name, phone, hourly_rate AS hourlyRate FROM users WHERE id = ? AND role = 'employee'`).bind(id).first<{ name: string } & Record<string, unknown>>();
      if (before) await audit(user, "delete", "employee", id, `Removed employee ${before.name}, their time cards, and time-off requests`, { before });
      await database().prepare(`DELETE FROM users WHERE id = ? AND role = 'employee'`).bind(id).run();
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
