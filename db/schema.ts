import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone").notNull().default(""),
  role: text("role", { enum: ["admin", "employee"] }).notNull(),
  pinHash: text("pin_hash").notNull(),
  pinSalt: text("pin_salt").notNull(),
  hourlyRate: real("hourly_rate").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const employeePayRates = sqliteTable(
  "employee_pay_rates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    rate: real("rate").notNull().default(0),
    effectiveFrom: text("effective_from").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("employee_pay_rate_user_date").on(table.userId, table.effectiveFrom)],
);

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

export const timeEntries = sqliteTable(
  "time_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    jobId: integer("job_id").notNull().references(() => jobs.id),
    workDate: text("work_date").notNull(),
    hours: real("hours").notNull().default(0),
    note: text("note").notNull().default(""),
    flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
    flagReason: text("flag_reason").notNull().default(""),
    resolution: text("resolution").notNull().default(""),
    resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("entry_user_job_date").on(table.userId, table.jobId, table.workDate)],
);

export const payWeeks = sqliteTable(
  "pay_weeks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    weekStart: text("week_start").notNull(),
    paid: integer("paid", { mode: "boolean" }).notNull().default(false),
    checkNumber: text("check_number").notNull().default(""),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("pay_week_user_start").on(table.userId, table.weekStart)],
);

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: integer("actor_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull().default(""),
    summary: text("summary").notNull(),
    details: text("details").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("audit_log_created_at").on(table.createdAt)],
);

export const timeOffRequests = sqliteTable(
  "time_off_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    note: text("note").notNull().default(""),
    status: text("status", { enum: ["pending", "approved", "denied", "cancelled"] }).notNull().default("pending"),
    reviewedBy: integer("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note").notNull().default(""),
    requestedAt: text("requested_at").notNull(),
    reviewedAt: text("reviewed_at"),
    updatedAt: text("updated_at").notNull(),
    reminderNotificationId: text("reminder_notification_id"),
    reminderSentAt: text("reminder_sent_at"),
  },
  (table) => [
    index("time_off_user_dates").on(table.userId, table.startDate, table.endDate),
    index("time_off_status_start").on(table.status, table.startDate),
  ],
);
