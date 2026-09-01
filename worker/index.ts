/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { detectJobMismatches } from "../app/job-mismatch-logic.mjs";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BACKUPS: R2Bucket;
  ONESIGNAL_APP_ID?: string;
  ONESIGNAL_API_KEY?: string;
  ONESIGNAL_SAFARI_WEB_ID?: string;
  TIME_CARD_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

function easternClock(timestamp: number) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
}

function nextDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function reminderRange(startDate: string, endDate: string) {
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const start = format.format(new Date(`${startDate}T12:00:00Z`));
  const end = format.format(new Date(`${endDate}T12:00:00Z`));
  return startDate === endDate ? start : `${start}–${end}`;
}

async function processTimeOffReminders(env: Env, scheduledTime: number) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY) return;
  const clock = easternClock(scheduledTime);
  if (Number(clock.hour) < 18) return;
  const localDate = `${clock.year}-${clock.month}-${clock.day}`;
  const startDate = nextDate(localDate);
  const [requests, admins] = await Promise.all([
    env.DB.prepare(
      `SELECT r.id, r.start_date AS startDate, r.end_date AS endDate, u.name AS userName
       FROM time_off_requests r JOIN users u ON u.id = r.user_id
       WHERE r.status = 'approved' AND r.start_date = ? AND r.reminder_sent_at IS NULL
       ORDER BY r.id`,
    ).bind(startDate).all<{ id: number; startDate: string; endDate: string; userName: string }>(),
    env.DB.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id`).all<{ id: number }>(),
  ]);
  const adminIds = admins.results.map((item) => `timecard-user-${item.id}`);
  if (!adminIds.length) return;
  for (const request of requests.results) {
    const claimedAt = new Date(scheduledTime).toISOString();
    const claimed = await env.DB.prepare(
      `UPDATE time_off_requests SET reminder_sent_at = ?, updated_at = ? WHERE id = ? AND reminder_sent_at IS NULL`,
    ).bind(claimedAt, claimedAt, request.id).run();
    if (!claimed.meta.changes) continue;
    try {
      const response = await fetch("https://api.onesignal.com/notifications", {
        method: "POST",
        headers: {
          Authorization: `Key ${env.ONESIGNAL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          app_id: env.ONESIGNAL_APP_ID,
          include_aliases: { external_id: adminIds },
          target_channel: "push",
          headings: { en: "Time off tomorrow" },
          contents: { en: `${request.userName} is off ${reminderRange(request.startDate, request.endDate)}.` },
          url: `${(env.TIME_CARD_URL || "https://time-card.tylerberg45.chatgpt.site").replace(/\/$/, "")}/?tab=timeoff&request=${request.id}`,
        }),
      });
      const result = await response.json() as { id?: string };
      if (!response.ok || !result.id) throw new Error(`OneSignal returned ${response.status}.`);
    } catch (error) {
      console.error("Time-off reminder failed", error);
      await env.DB.prepare(`UPDATE time_off_requests SET reminder_sent_at = NULL WHERE id = ?`).bind(request.id).run();
    }
  }
}

async function processJobMismatchReviews(env: Env) {
  const rows = (await env.DB.prepare(
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
    await env.DB.prepare(
      `INSERT OR IGNORE INTO job_mismatch_reviews
       (fingerprint, user_a_id, user_b_id, job_a_id, job_b_id, start_date, end_date, dates, entry_ids_a, entry_ids_b,
        hours_a, hours_b, confidence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      review.fingerprint, review.userAId, review.userBId, review.jobAId, review.jobBId,
      review.startDate, review.endDate, JSON.stringify(review.dates), JSON.stringify(review.entryIdsA),
      JSON.stringify(review.entryIdsB), review.hoursA, review.hoursB, review.confidence, now, now,
    ).run();
  }
  const pending = (await env.DB.prepare(
    `SELECT id, fingerprint, notification_sent_at AS notificationSentAt FROM job_mismatch_reviews WHERE status = 'pending'`,
  ).all()).results as Array<{ id: number; fingerprint: string; notificationSentAt: string | null }>;
  for (const stored of pending) {
    if (!fingerprints.has(stored.fingerprint)) {
      await env.DB.prepare(`UPDATE job_mismatch_reviews SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(now, stored.id).run();
    }
  }
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY) return;
  const admins = await env.DB.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id`).all<{ id: number }>();
  const adminIds = admins.results.map((item) => `timecard-user-${item.id}`);
  if (!adminIds.length) return;
  const baseUrl = (env.TIME_CARD_URL || "https://time-card.tylerberg45.chatgpt.site").replace(/\/$/, "");
  const byFingerprint = new Map(detected.map((item) => [item.fingerprint, item]));
  for (const stored of pending) {
    if (stored.notificationSentAt || !fingerprints.has(stored.fingerprint)) continue;
    const review = byFingerprint.get(stored.fingerprint);
    if (!review) continue;
    const claimed = await env.DB.prepare(
      `UPDATE job_mismatch_reviews SET notification_sent_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND notification_sent_at IS NULL`,
    ).bind(now, now, stored.id).run();
    if (!claimed.meta.changes) continue;
    const url = `${baseUrl}/?tab=jobreviews&review=${stored.id}`;
    try {
      const response = await fetch("https://api.onesignal.com/notifications", {
        method: "POST",
        headers: { Authorization: `Key ${env.ONESIGNAL_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: env.ONESIGNAL_APP_ID,
          include_aliases: { external_id: adminIds },
          target_channel: "push",
          headings: { en: "Possible job mismatch" },
          contents: { en: `${review.userAName} used ${review.jobAName} while ${review.userBName} used ${review.jobBName} for ${reminderRange(review.startDate, review.endDate)}. Tap to review.` },
          url,
          web_buttons: [{ id: "review", text: "Review", url }],
        }),
      });
      const result = await response.json() as { id?: string };
      if (!response.ok || !result.id) throw new Error(`OneSignal returned ${response.status}.`);
      await env.DB.batch([
        env.DB.prepare(`UPDATE job_mismatch_reviews SET notification_id = ?, updated_at = ? WHERE id = ?`).bind(result.id, now, stored.id),
        env.DB.prepare(
          `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, summary, details, created_at)
           VALUES (NULL, 'HazenTime', 'detect', 'job_mismatch', ?, ?, ?, ?)`,
        ).bind(
          String(stored.id),
          `Detected a possible job mismatch for ${reminderRange(review.startDate, review.endDate)}`,
          JSON.stringify({ fingerprint: review.fingerprint, userA: review.userAName, jobA: review.jobAName, userB: review.userBName, jobB: review.jobBName }),
          now,
        ),
      ]);
    } catch (error) {
      console.error("Job mismatch notification failed", error);
      await env.DB.prepare(`UPDATE job_mismatch_reviews SET notification_sent_at = NULL, updated_at = ? WHERE id = ?`).bind(now, stored.id).run();
    }
  }
}

async function createDailyBackup(env: Env, scheduledTime: number) {
  const clock = easternClock(scheduledTime);
  if (Number(clock.hour) < 2) return;
  const localDate = `${clock.year}-${clock.month}-${clock.day}`;
  const key = `daily/${localDate}.json`;
  if (await env.BACKUPS.head(key)) return;

  const [users, jobs, entries, payWeeks, payRateHistory, timeOff, jobMismatchReviews, expenses, history] = await Promise.all([
    env.DB.prepare(`SELECT id, name, phone, role, pin_hash AS pinHash, pin_salt AS pinSalt, hourly_rate AS hourlyRate, active, created_at AS createdAt FROM users ORDER BY id`).all(),
    env.DB.prepare(`SELECT id, name, active, created_at AS createdAt FROM jobs ORDER BY id`).all(),
    env.DB.prepare(`SELECT id, user_id AS userId, job_id AS jobId, work_date AS workDate, hours, note, flagged, flag_reason AS flagReason, resolution, resolved, updated_at AS updatedAt FROM time_entries ORDER BY work_date, id`).all(),
    env.DB.prepare(`SELECT id, user_id AS userId, week_start AS weekStart, paid, received, payment_date AS paymentDate, payment_method AS paymentMethod, check_number AS checkNumber, updated_at AS updatedAt FROM pay_weeks ORDER BY week_start, id`).all(),
    env.DB.prepare(`SELECT id, user_id AS userId, rate, effective_from AS effectiveFrom, created_at AS createdAt FROM employee_pay_rates ORDER BY user_id, effective_from, id`).all(),
    env.DB.prepare(`SELECT id, user_id AS userId, start_date AS startDate, end_date AS endDate, note, status, reviewed_by AS reviewedBy, review_note AS reviewNote, requested_at AS requestedAt, reviewed_at AS reviewedAt, updated_at AS updatedAt, reminder_notification_id AS reminderNotificationId, reminder_sent_at AS reminderSentAt FROM time_off_requests ORDER BY start_date, id`).all(),
    env.DB.prepare(`SELECT id, fingerprint, user_a_id AS userAId, user_b_id AS userBId, job_a_id AS jobAId, job_b_id AS jobBId, start_date AS startDate, end_date AS endDate, dates, entry_ids_a AS entryIdsA, entry_ids_b AS entryIdsB, hours_a AS hoursA, hours_b AS hoursB, confidence, status, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt, selected_job_id AS selectedJobId, notification_id AS notificationId, notification_sent_at AS notificationSentAt, created_at AS createdAt, updated_at AS updatedAt FROM job_mismatch_reviews ORDER BY id`).all(),
    env.DB.prepare(`SELECT id, job_id AS jobId, created_by AS createdBy, purchase_date AS purchaseDate, vendor, category, amount, note, ocr_text AS ocrText, reviewed, receipt_key AS receiptKey, receipt_type AS receiptType, created_at AS createdAt, updated_at AS updatedAt FROM expenses ORDER BY purchaseDate, id`).all(),
    env.DB.prepare(`SELECT id, actor_id AS actorId, actor_name AS actorName, action, target_type AS targetType, target_id AS targetId, summary, details, created_at AS createdAt FROM audit_log ORDER BY id`).all(),
  ]);
  await env.BACKUPS.put(key, JSON.stringify({
    format: "hazentime-private-backup-v3",
    exportedAt: new Date(scheduledTime).toISOString(),
    users: users.results,
    jobs: jobs.results,
    timeEntries: entries.results,
    payWeeks: payWeeks.results,
    payRateHistory: payRateHistory.results,
    timeOffRequests: timeOff.results,
    jobMismatchReviews: jobMismatchReviews.results,
    expenses: expenses.results,
    auditLog: history.results,
  }), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { localDate, retention: "45-days" },
  });

  const stored = await env.BACKUPS.list({ prefix: "daily/", limit: 1000 });
  const expired = stored.objects.sort((left, right) => right.key.localeCompare(left.key)).slice(45);
  if (expired.length) await env.BACKUPS.delete(expired.map((item) => item.key));
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const globals = globalThis as typeof globalThis & {
      __TIME_CARD_DB?: D1Database;
      __TIME_CARD_BACKUPS?: R2Bucket;
      __TIME_CARD_PUSH?: { appId?: string; apiKey?: string; safariWebId?: string };
    };
    globals.__TIME_CARD_DB = env.DB;
    globals.__TIME_CARD_BACKUPS = env.BACKUPS;
    globals.__TIME_CARD_PUSH = {
      appId: env.ONESIGNAL_APP_ID,
      apiKey: env.ONESIGNAL_API_KEY,
      safariWebId: env.ONESIGNAL_SAFARI_WEB_ID,
    };
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([
      processTimeOffReminders(env, controller.scheduledTime),
      processJobMismatchReviews(env),
      createDailyBackup(env, controller.scheduledTime),
    ]));
  },
};

export default worker;
