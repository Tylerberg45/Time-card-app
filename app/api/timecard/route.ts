type Payload = Record<string, unknown>;
type SessionUser = { id: number; name: string; role: "admin" | "employee" };

const COOKIE = "timecard_session";
const encoder = new TextEncoder();

function database() {
  const db = (globalThis as typeof globalThis & { __TIME_CARD_DB?: D1Database }).__TIME_CARD_DB;
  if (!db) throw new Error("The time card database is unavailable.");
  return db;
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
    `CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS time_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL REFERENCES jobs(id), work_date TEXT NOT NULL, hours REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', flagged INTEGER NOT NULL DEFAULT 0, flag_reason TEXT NOT NULL DEFAULT '', resolution TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS entry_user_job_date ON time_entries(user_id, job_id, work_date)`,
    `CREATE TABLE IF NOT EXISTS pay_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS pay_week_user_start ON pay_weeks(user_id, week_start)`,
    `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
  ];
  await db.batch(statements.map((sql) => db.prepare(sql)));
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
        `SELECT id, user_id AS userId, job_id AS jobId, work_date AS workDate, hours, note, flagged, flag_reason AS flagReason, resolution, resolved FROM time_entries WHERE user_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date, job_id`,
      ).bind(targetId, weekStart, weekEnd).all()).results
    : [];
  const pay = target
    ? await database().prepare(`SELECT paid FROM pay_weeks WHERE user_id = ? AND week_start = ?`).bind(targetId, weekStart).first<{ paid: number }>()
    : null;
  return { configured: true, user, weekStart, weekEnd, jobs, employees, target, entries, paid: Boolean(pay?.paid) };
}

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const count = await database().prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`).first<{ count: number }>();
    if (!count?.count) return json({ configured: false });
    const url = new URL(request.url);
    const user = await currentUser(request);
    if (!user) {
      const people = (await database().prepare(`SELECT id, name FROM users WHERE role = 'employee' ORDER BY name`).all()).results;
      const admins = (await database().prepare(`SELECT id, name FROM users WHERE role = 'admin' ORDER BY name`).all()).results;
      return json({ configured: true, authenticated: false, employees: people, admins });
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
        await database().prepare(
          `DELETE FROM time_entries WHERE user_id = ? AND job_id = ? AND work_date = ?`,
        ).bind(targetId, jobId, workDate).run();
        return json({ ok: true, deleted: true });
      }
      await database().prepare(
        `INSERT INTO time_entries (user_id, job_id, work_date, hours, note, flagged, flag_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, job_id, work_date) DO UPDATE SET hours=excluded.hours, note=excluded.note, flagged=excluded.flagged, flag_reason=excluded.flag_reason, updated_at=excluded.updated_at`,
      ).bind(targetId, jobId, workDate, hours, note, flagged ? 1 : 0, flagReason, now).run();
      return json({ ok: true });
    }

    if (action === "resolve") {
      if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
      await database().prepare(`UPDATE time_entries SET resolution = ?, resolved = ?, updated_at = ? WHERE id = ?`)
        .bind(String(body.resolution ?? "").trim().slice(0, 500), body.resolved ? 1 : 0, now, Number(body.entryId)).run();
      return json({ ok: true });
    }

    if (action === "setPaid") {
      const targetId = user.role === "admin" ? Number(body.userId) : user.id;
      const weekStart = sundayOf(body.weekStart);
      await database().prepare(
        `INSERT INTO pay_weeks (user_id, week_start, paid, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, week_start) DO UPDATE SET paid=excluded.paid, updated_at=excluded.updated_at`,
      ).bind(targetId, weekStart, body.paid ? 1 : 0, now).run();
      return json({ ok: true });
    }

    if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);

    if (action === "saveEmployee") {
      const id = Number(body.id);
      const name = String(body.name ?? "").trim();
      const phone = String(body.phone ?? "").trim().slice(0, 30);
      const hourlyRate = Math.max(0, Number(body.hourlyRate) || 0);
      const pin = String(body.pin ?? "");
      if (!name || (!id && !/^\d{4,6}$/.test(pin))) return json({ error: "Name and a 4–6 digit PIN are required." }, 400);
      if (id) {
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
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        await database().prepare(`INSERT INTO users (name, phone, role, pin_hash, pin_salt, hourly_rate, created_at) VALUES (?, ?, 'employee', ?, ?, ?, ?)`)
          .bind(name, phone, await pinHash(pin, salt), salt, hourlyRate, now).run();
      }
      return json({ ok: true });
    }

    if (action === "deleteEmployee") {
      await database().prepare(`DELETE FROM users WHERE id = ? AND role = 'employee'`).bind(Number(body.id)).run();
      return json({ ok: true });
    }

    if (action === "saveJob") {
      const id = Number(body.id);
      const name = String(body.name ?? "").trim();
      if (!name) return json({ error: "Job name is required." }, 400);
      if (id) await database().prepare(`UPDATE jobs SET name=? WHERE id=?`).bind(name, id).run();
      else await database().prepare(`INSERT INTO jobs (name, created_at) VALUES (?, ?)`).bind(name, now).run();
      return json({ ok: true });
    }

    if (action === "deleteJob") {
      const id = Number(body.id);
      const used = await database().prepare(`SELECT COUNT(*) AS count FROM time_entries WHERE job_id=?`).bind(id).first<{ count: number }>();
      if (used?.count) return json({ error: "This job has time entries and cannot be removed." }, 409);
      await database().prepare(`DELETE FROM jobs WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("Time card change failed", error);
    return json({ error: "That change could not be saved." }, 500);
  }
}
