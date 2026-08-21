/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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
    env.DB.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id`).all<{ id: number }>(),
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
          url: `${(env.TIME_CARD_URL || "https://time-card.tylerberg45.chatgpt.site").replace(/\/$/, "")}/?tab=timeoff`,
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

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const globals = globalThis as typeof globalThis & {
      __TIME_CARD_DB?: D1Database;
      __TIME_CARD_PUSH?: { appId?: string; apiKey?: string; safariWebId?: string };
    };
    globals.__TIME_CARD_DB = env.DB;
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
    ctx.waitUntil(processTimeOffReminders(env, controller.scheduledTime));
  },
};

export default worker;
