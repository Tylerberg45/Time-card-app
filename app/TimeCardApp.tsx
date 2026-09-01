"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

declare const __TIME_CARD_BUILD_ID__: string;

type Person = { id: number; name: string; phone?: string; hourlyRate?: number; archived?: boolean };
type Job = { id: number; name: string; active: number };
type Entry = { id: number; userId: number; jobId: number; workDate: string; hours: number; hourlyRate?: number; note: string; flagged: number; flagReason: string; resolution: string; resolved: number };
type TimeOffRequest = { id: number; userId: number; userName: string; startDate: string; endDate: string; note: string; status: "pending" | "approved" | "denied" | "cancelled"; reviewNote: string; requestedAt: string; reviewedAt?: string };
type PayReportData = {
  employee: { id: number; name: string; hourlyRate: number };
  startDate: string; endDate: string; generatedAt: string;
  entries: Array<{ workDate: string; job: string; hours: number; hourlyRate: number }>;
  paidWeeks: Array<{ weekStart: string; paid: number; received: number; paymentDate: string; paymentMethod: string; checkNumber: string }>;
};
type PayReportWeek = { weekStart: string; hours: number; pay: number; rates: number[]; paid: boolean; received: boolean; paymentDate: string; paymentMethod: string; checkNumber: string };
type JobHoursReportData = {
  jobs: Array<{
    id: number;
    name: string;
    active: boolean;
    totalHours: number;
    people: Array<{ id: number; name: string; hours: number; archived: boolean }>;
  }>;
};
type JobMismatchReview = {
  id: number;
  startDate: string;
  endDate: string;
  dates: string[];
  hoursA: number;
  hoursB: number;
  confidence: "possible" | "likely";
  userAId: number;
  userAName: string;
  userBId: number;
  userBName: string;
  jobAId: number;
  jobAName: string;
  jobBId: number;
  jobBName: string;
  createdAt: string;
};
type OneSignalApi = {
  init: (options: Record<string, unknown>) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  Notifications: { permission?: boolean; requestPermission: () => Promise<void> };
};
declare global {
  interface Window {
    OneSignalDeferred?: Array<(oneSignal: OneSignalApi) => void | Promise<void>>;
    __timeCardPushInitialized?: boolean;
  }
}
type Data = {
  configured: boolean; authenticated?: boolean;
  admins?: Person[]; employees?: Person[]; archivedEmployees?: Person[]; user?: Person & { role: "admin" | "employee" };
  weekStart?: string; weekEnd?: string; jobs?: Job[]; target?: Person | null; entries?: Entry[];
  paid?: boolean; received?: boolean; paymentDate?: string; paymentMethod?: string; checkNumber?: string;
  pendingTimeOffCount?: number;
  pendingJobReviewCount?: number;
  syncToken?: string;
  push?: { configured: boolean; sendingConfigured?: boolean; appId?: string; safariWebId?: string; externalId?: string };
};
type AuditItem = { id: number; actorName: string; action: string; targetType: string; targetId: string; summary: string; details: string; createdAt: string };

const api = async (body?: Record<string, unknown>, query = "") => {
  const response = await fetch(`/api/timecard${query}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Something went wrong.");
  return data;
};

const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return iso(date);
};
const dayLabel = (value: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const monthLabel = (value: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T12:00:00Z`));
const dateRangeLabel = (start: string, end: string) => start === end ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(end)}`;
const today = () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const weekStartFor = (value: string) => {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - date.getUTCDay()); return iso(date);
};
const reportDate = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const rateList = (rates: number[]) => [...new Set(rates.map((rate) => Number(rate)))].sort((a, b) => a - b);
const rateLabel = (rates: number[]) => rateList(rates).map((rate) => money(rate)).join(" / ");
const reportWeeks = (report: PayReportData): PayReportWeek[] => {
  const payments = new Map(report.paidWeeks.map((item) => [item.weekStart, item]));
  const weeks = new Map<string, PayReportWeek>();
  report.entries.forEach((entry) => {
    const weekStart = weekStartFor(entry.workDate);
    const payment = payments.get(weekStart);
    const row = weeks.get(weekStart) ?? {
      weekStart, hours: 0, pay: 0, rates: [], paid: Boolean(payment?.paid), received: Boolean(payment?.received),
      paymentDate: payment?.paymentDate ?? "", paymentMethod: payment?.paymentMethod ?? "", checkNumber: payment?.checkNumber ?? "",
    };
    row.hours += Number(entry.hours);
    row.pay += Number(entry.hours) * Number(entry.hourlyRate);
    row.rates = rateList([...row.rates, Number(entry.hourlyRate)]);
    weeks.set(weekStart, row);
  });
  return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
};
const paymentSummary = (week: Pick<PayReportWeek, "paid" | "received" | "paymentDate" | "paymentMethod" | "checkNumber">) => {
  if (!week.paid) return week.received ? "Receipt confirmed; not marked issued" : "Not marked issued";
  return [
    "Issued",
    week.paymentDate ? reportDate(week.paymentDate) : "",
    week.paymentMethod,
    week.checkNumber ? `Check #${week.checkNumber}` : "",
    week.received ? "Receipt confirmed" : "Awaiting receipt confirmation",
  ].filter(Boolean).join(" · ");
};
const shiftMonth = (value: string, amount: number) => {
  const date = new Date(`${value}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + amount); return iso(date).slice(0, 7);
};

// Change this version and update the items whenever a user-facing release ships.
const RELEASE_NOTES = {
  version: "2026.08.21.4",
  date: "August 21, 2026",
  items: [
    { audience: "all", title: "Calendar-style time cards", detail: "Tap a day, enter or edit time, save it, and see the hours right in the calendar." },
    { audience: "all", title: "Time-off calendar", detail: "Request days off in the app, see their status, and let Corbin approve or deny requests." },
    { audience: "admin", title: "Pay reports", detail: "Create year-to-date or custom-date pay records, print or share them, and optionally include check numbers." },
    { audience: "admin", title: "More accurate pay history", detail: "Reports use the hourly rate that was in effect on each work date, even after a raise." },
    { audience: "all", title: "Automatic updates", detail: "Saved changes now appear automatically, and future app releases refresh without everyone closing the app." },
    { audience: "admin", title: "Push notifications", detail: "Receive push notifications for new time-off requests plus reminders before an employee is off." },
    { audience: "employee", title: "Time-off push notifications", detail: "Receive a push notification when Corbin approves or denies requested time off." },
    { audience: "employee", title: "Download your pay history", detail: "Create a weekly, year-to-date, last-year, or custom pay statement and download, print, or share the PDF from your phone." },
    { audience: "all", title: "Clearer payment records", detail: "Corbin records when payment was issued, while employees separately confirm when it was received." },
    { audience: "all", title: "Safer time entry", detail: "HazenTime warns before saving future dates or more than 24 total hours in one day." },
    { audience: "all", title: "Protected PIN sign-in", detail: "Repeated incorrect PIN attempts now trigger a short security cooldown." },
    { audience: "admin", title: "Employee records stay safe", detail: "Removing an employee now hides their access without erasing time cards, pay history, or requests—and they can be restored." },
    { audience: "admin", title: "Automatic private backups", detail: "A private recovery backup is now created every day and retained for 45 days." },
    { audience: "admin", title: "Faster time-off review", detail: "Time-off alerts now open the exact request, with quick Approve and Deny actions where the phone supports them." },
  ],
};

// BETA_HOME_REFERENCE_CLASSIC_V26: the classic tabbed administrator screen
// below remains the rollback target. To force the old screen during testing,
// change BETA_HOME_DEFAULT to false; the in-app switch is the normal rollback.
const BETA_HOME_DEFAULT = true;
const BETA_HOME_STORAGE_PREFIX = "hazentime-home-mode:";
type HomeMode = "beta" | "classic";
type AppTab = "home" | "time" | "timeoff" | "people" | "jobs" | "jobreports" | "jobreviews" | "reports" | "history" | "account";

export default function TimeCardApp() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedLogin, setSelectedLogin] = useState<{ id: number; name: string; kind: string } | null>(null);
  const [week, setWeek] = useState("");
  const [employeeId, setEmployeeId] = useState(0);
  const [tab, setTab] = useState<AppTab>("time");
  const [homeMode, setHomeMode] = useState<HomeMode>(BETA_HOME_DEFAULT ? "beta" : "classic");
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const dirtyRef = useRef(false);
  const syncTokenRef = useRef<string | null>(null);
  const clearDirty = useCallback(() => { dirtyRef.current = false; }, []);

  const load = useCallback(async (nextWeek?: string, nextEmployee?: number, quiet = false) => {
    try {
      if (!quiet) setError("");
      const w = nextWeek ?? week;
      const e = nextEmployee ?? employeeId;
      const result = await api(undefined, `${w ? `?week=${w}` : ""}${e ? `${w ? "&" : "?"}employeeId=${e}` : ""}`);
      setData(result);
      syncTokenRef.current = result.syncToken ?? syncTokenRef.current;
      if (result.weekStart) setWeek(result.weekStart);
      if (result.target?.id) setEmployeeId(result.target.id);
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "Could not load.");
    }
  }, [week, employeeId]);

  useEffect(() => {
    let active = true;
    api().then((result) => {
      if (!active) return;
      setData(result);
      syncTokenRef.current = result.syncToken ?? null;
      if (result.weekStart) setWeek(result.weekStart);
      if (result.target?.id) setEmployeeId(result.target.id);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load.");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const markDirty = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".timeModal, .requestForm, .editorCard, .checkNumberEdit, .pinForm, .authCard")) {
        dirtyRef.current = true;
      }
    };
    document.addEventListener("input", markDirty, true);
    document.addEventListener("change", markDirty, true);
    return () => {
      document.removeEventListener("input", markDirty, true);
      document.removeEventListener("change", markDirty, true);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let checking = false;
    const checkForUpdates = async () => {
      if (!active || checking || document.visibilityState !== "visible" || busy || dirtyRef.current || document.querySelector(".timeModal")) return;
      checking = true;
      try {
        const result = await api(undefined, `?sync=1&_=${Date.now()}`) as { buildId?: string; syncToken?: string };
        if (!active) return;
        if (result.buildId && result.buildId !== __TIME_CARD_BUILD_ID__) {
          window.location.reload();
          return;
        }
        if (result.syncToken && result.syncToken !== syncTokenRef.current) {
          await load(undefined, undefined, true);
        }
      } catch {
        // A background refresh should never interrupt normal time entry.
      } finally {
        checking = false;
      }
    };
    const firstCheck = window.setTimeout(() => void checkForUpdates(), 5_000);
    const interval = window.setInterval(() => void checkForUpdates(), 15_000);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkForUpdates();
    };
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      active = false;
      window.clearTimeout(firstCheck);
      window.clearInterval(interval);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [busy, load]);

  useEffect(() => {
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab !== "timeoff" && requestedTab !== "jobreviews") return;
    const timer = window.setTimeout(() => setTab(requestedTab), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!data?.user?.id || data.user.role !== "admin") return;
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab === "timeoff" || requestedTab === "jobreviews") return;
    let storedMode: HomeMode = BETA_HOME_DEFAULT ? "beta" : "classic";
    try {
      storedMode = window.localStorage.getItem(`${BETA_HOME_STORAGE_PREFIX}${data.user.id}`) === "classic" ? "classic" : storedMode;
    } catch {
      // The beta remains available for this visit if storage is unavailable.
    }
    const timer = window.setTimeout(() => { setHomeMode(storedMode); setTab(storedMode === "beta" ? "home" : "time"); }, 0);
    return () => window.clearTimeout(timer);
  }, [data?.user?.id, data?.user?.role]);

  useEffect(() => {
    if (!data?.user?.id) {
      const timer = window.setTimeout(() => setShowWhatsNew(false), 0);
      return () => window.clearTimeout(timer);
    }
    let shouldShow = true;
    try {
      const seenVersion = window.localStorage.getItem(`hazentime-whats-new:${data.user.id}`);
      shouldShow = seenVersion !== RELEASE_NOTES.version;
    } catch {
      // If storage is unavailable, show the notes for this visit.
    }
    const timer = window.setTimeout(() => setShowWhatsNew(shouldShow), 0);
    return () => window.clearTimeout(timer);
  }, [data?.user?.id]);

  useEffect(() => {
    if (!showWhatsNew) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowWhatsNew(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [showWhatsNew]);

  const act = async (body: Record<string, unknown>, reload = true) => {
    setBusy(true); setError("");
    try { await api(body); dirtyRef.current = false; if (reload) await load(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save."); return false; }
    finally { setBusy(false); }
  };

  if (!data) return <main className="center"><div className="spinner" /><p>Loading time cards…</p></main>;
  if (!data.configured) return <Setup busy={busy} error={error} onSubmit={async (name, pin) => { if (await act({ action: "setup", name, pin }, false)) await load(); }} />;
  if (!data.user) return <Login data={data} selected={selectedLogin} setSelected={setSelectedLogin} busy={busy} error={error} onLogin={async (pin) => { if (!selectedLogin) return; if (await act({ action: "login", userId: selectedLogin.id, pin }, false)) await load(); }} />;

  const isAdmin = data.user.role === "admin";
  const entries = data.entries ?? [];
  const totalHours = entries.reduce((sum, item) => sum + Number(item.hours), 0);
  const totalPay = entries.reduce((sum, item) => sum + Number(item.hours) * Number(item.hourlyRate ?? data.target?.hourlyRate ?? 0), 0);
  const weekRateLabel = rateLabel(entries.length ? entries.map((item) => Number(item.hourlyRate ?? data.target?.hourlyRate ?? 0)) : [Number(data.target?.hourlyRate ?? 0)]);
  const reportPeople = isAdmin ? [...(data.employees ?? []), ...(data.archivedEmployees ?? []).map((person) => ({ ...person, archived: true }))] : [data.user];
  const changeWeek = (days: number) => { dirtyRef.current = false; void load(addDays(week, days), employeeId); };
  const changeEmployee = (id: number) => { dirtyRef.current = false; setEmployeeId(id); void load(week, id); };
  const changeTab = (nextTab: typeof tab) => { dirtyRef.current = false; setTab(nextTab); };
  const changeHomeMode = (nextMode: HomeMode) => {
    try { window.localStorage.setItem(`${BETA_HOME_STORAGE_PREFIX}${data.user!.id}`, nextMode); } catch { /* session-only fallback */ }
    setHomeMode(nextMode);
    setShowAdminMenu(false);
    changeTab(nextMode === "beta" ? "home" : "time");
  };
  const dismissWhatsNew = () => {
    try {
      window.localStorage.setItem(`hazentime-whats-new:${data.user!.id}`, RELEASE_NOTES.version);
    } catch {
      // The popup can still be dismissed for this visit when storage is unavailable.
    }
    setShowWhatsNew(false);
  };

  return (
    <main className="appShell">
      <header className="topbar">
        <div><span className="eyebrow">Hazen Construction</span><h1>Time Card</h1></div>
        <div className="topbarActions">
          <button className="textButton whatsNewButton" onClick={() => setShowWhatsNew(true)}>What&apos;s new</button>
          <button className="textButton" onClick={async () => { await act({ action: "logout" }, false); setSelectedLogin(null); await load(); }}>Sign out</button>
        </div>
      </header>
      {showWhatsNew && <div className="whatsNewBackdrop" onClick={(event) => { if (event.target === event.currentTarget) dismissWhatsNew(); }}>
        <section className="whatsNewCard" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
          <div className="whatsNewHead">
            <div className="whatsNewIcon" aria-hidden="true">✦</div>
            <div><span className="eyebrow">New in HazenTime</span><h2 id="whats-new-title">Here&apos;s what&apos;s new for you</h2><p>{RELEASE_NOTES.date}</p></div>
          </div>
          <div className="whatsNewList">
            {RELEASE_NOTES.items.filter((item) => item.audience === "all" || item.audience === data.user?.role).map((item) => <article key={item.title}>
              <span aria-hidden="true">✓</span>
              <div><h3>{item.title}</h3><p>{item.detail}</p></div>
            </article>)}
          </div>
          <button className="primary whatsNewDone" onClick={dismissWhatsNew}>Got it</button>
        </section>
      </div>}
      <nav className={`tabs ${isAdmin && homeMode === "beta" ? "betaTabs" : ""}`}>
        {isAdmin && homeMode === "beta" ? <>
          <button className={tab === "home" ? "active" : ""} onClick={() => changeTab("home")}>Command Center</button>
          <button className="betaMenuButton" onClick={() => setShowAdminMenu(!showAdminMenu)} aria-expanded={showAdminMenu}>Menu{(Number(data.pendingTimeOffCount) + Number(data.pendingJobReviewCount)) > 0 && <span className="tabBadge">{Number(data.pendingTimeOffCount ?? 0) + Number(data.pendingJobReviewCount ?? 0)}</span>}</button>
        </> : <>
          <button className={tab === "time" ? "active" : ""} onClick={() => changeTab("time")}>Time cards</button>
          <button className={tab === "timeoff" ? "active" : ""} onClick={() => changeTab("timeoff")}>Time off{Boolean(data.pendingTimeOffCount) && <span className="tabBadge">{data.pendingTimeOffCount}</span>}</button>
          <button className={tab === "reports" ? "active" : ""} onClick={() => changeTab("reports")}>{isAdmin ? "Pay reports" : "Pay history"}</button>
          {isAdmin && <>
            <button className={tab === "people" ? "active" : ""} onClick={() => changeTab("people")}>Employees</button>
            <button className={tab === "jobs" ? "active" : ""} onClick={() => changeTab("jobs")}>Jobs</button>
            <button className={tab === "jobreports" ? "active" : ""} onClick={() => changeTab("jobreports")}>Job hours</button>
            <button className={tab === "jobreviews" ? "active" : ""} onClick={() => changeTab("jobreviews")}>Job reviews{Boolean(data.pendingJobReviewCount) && <span className="tabBadge">{data.pendingJobReviewCount}</span>}</button>
            <button className={tab === "history" ? "active" : ""} onClick={() => changeTab("history")}>History & backup</button>
            <button className={tab === "account" ? "active" : ""} onClick={() => changeTab("account")}>Admin account</button>
          </>}
        </>}
      </nav>
      {isAdmin && homeMode === "beta" && showAdminMenu && <div className="adminMenu" role="dialog" aria-label="Administrator menu">
        <div className="adminMenuHead"><div><span className="eyebrow">Beta Home Screen</span><h3>All admin tools</h3></div><button className="modalClose" aria-label="Close menu" onClick={() => setShowAdminMenu(false)}>×</button></div>
        <div className="adminMenuGrid">
          <button onClick={() => { changeTab("time"); setShowAdminMenu(false); }}>Time cards</button>
          <button onClick={() => { changeTab("timeoff"); setShowAdminMenu(false); }}>Time off{Boolean(data.pendingTimeOffCount) && <span className="tabBadge">{data.pendingTimeOffCount}</span>}</button>
          <button onClick={() => { changeTab("reports"); setShowAdminMenu(false); }}>Pay reports</button>
          <button onClick={() => { changeTab("jobreviews"); setShowAdminMenu(false); }}>Job reviews{Boolean(data.pendingJobReviewCount) && <span className="tabBadge">{data.pendingJobReviewCount}</span>}</button>
          <button onClick={() => { changeTab("people"); setShowAdminMenu(false); }}>Employees</button>
          <button onClick={() => { changeTab("jobs"); setShowAdminMenu(false); }}>Jobs</button>
          <button onClick={() => { changeTab("jobreports"); setShowAdminMenu(false); }}>Job hours</button>
          <button onClick={() => { changeTab("history"); setShowAdminMenu(false); }}>History & backup</button>
          <button onClick={() => { changeTab("account"); setShowAdminMenu(false); }}>Admin account</button>
        </div>
        <button className="classicSwitch" onClick={() => changeHomeMode("classic")}>Use classic Home Screen</button>
        <small className="homeReference">Rollback reference: classic-admin-tabs-v26</small>
      </div>}
      {error && <div className="alert">{error}</div>}

      {tab === "home" && isAdmin && homeMode === "beta" ? <CommandCenter data={data} onNavigate={changeTab} onUseClassic={() => changeHomeMode("classic")} /> :
       tab === "timeoff" ? <TimeOff data={data} busy={busy} act={act} /> :
       tab === "people" && isAdmin ? <People people={data.employees ?? []} archivedPeople={data.archivedEmployees ?? []} busy={busy} act={act} /> :
       tab === "jobs" && isAdmin ? <Jobs jobs={data.jobs ?? []} busy={busy} act={act} /> :
       tab === "jobreports" && isAdmin ? <JobHoursReport /> :
       tab === "jobreviews" && isAdmin ? <JobMismatchReviews busy={busy} act={act} /> :
       tab === "reports" ? <PayReports people={reportPeople} isAdmin={isAdmin} selectedWeek={week} /> :
       tab === "history" && isAdmin ? <History week={week} employeeId={employeeId} /> :
       tab === "account" && isAdmin ? <AdminAccount name={data.user.name} busy={busy} act={act} /> :
       <section>
        <div className="controls">
          {isAdmin && <label>Employee<select value={employeeId} onChange={(event) => changeEmployee(Number(event.target.value))}>
            <option value={data.user.id}>{data.user.name} (admin)</option>
            {(data.employees ?? []).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label>}
          <div className="weekPicker"><button onClick={() => changeWeek(-7)} aria-label="Previous week">‹</button><strong>{dayLabel(week)} – {dayLabel(data.weekEnd!)}</strong><button onClick={() => changeWeek(7)} aria-label="Next week">›</button></div>
        </div>
        {data.target ? <>
          <div className="summary">
            <div><span>Employee</span><strong>{data.target.name}</strong></div>
            <div><span>Total hours</span><strong>{totalHours.toFixed(2)}</strong></div>
            {isAdmin && <><div><span>{rateList(entries.map((item) => Number(item.hourlyRate ?? data.target?.hourlyRate ?? 0))).length > 1 ? "Rates used" : "Rate"}</span><strong>{weekRateLabel}/hr</strong></div><div className="payTotal"><span>Check amount</span><strong>{money(totalPay)}</strong></div></>}
            <PayWeekStatus key={`${data.target.id}-${week}`} isAdmin={isAdmin} paid={Boolean(data.paid)} received={Boolean(data.received)} paymentDate={data.paymentDate ?? ""} paymentMethod={data.paymentMethod ?? ""} checkNumber={data.checkNumber ?? ""} userId={data.target.id} weekStart={week} busy={busy} act={act} />
          </div>
          <TimeGrid week={week} jobs={data.jobs ?? []} entries={entries} targetId={data.target.id} isAdmin={isAdmin} busy={busy} act={act} onEditorClose={clearDirty} />
        </> : <div className="empty"><h2>No employees yet</h2><p>Add an employee to start a time card.</p></div>}
      </section>}
    </main>
  );
}

function CommandCenter({ data, onNavigate, onUseClassic }: { data: Data; onNavigate: (tab: AppTab) => void; onUseClassic: () => void }) {
  const entries = data.entries ?? [];
  const totalHours = entries.reduce((sum, item) => sum + Number(item.hours), 0);
  const totalPay = entries.reduce((sum, item) => sum + Number(item.hours) * Number(item.hourlyRate ?? data.target?.hourlyRate ?? 0), 0);
  const activeJobs = (data.jobs ?? []).filter((job) => Boolean(job.active)).length;
  const pendingTimeOff = Number(data.pendingTimeOffCount ?? 0);
  const pendingJobReviews = Number(data.pendingJobReviewCount ?? 0);
  const pendingTotal = pendingTimeOff + pendingJobReviews;

  return <section className="commandCenter" data-home-reference="classic-admin-tabs-v26">
    <div className="sectionHead commandCenterHead">
      <div><span className="eyebrow">Beta Home Screen</span><h2>Command Center</h2><p className="sectionHint">The important stuff is here first. Open Menu for every admin tool.</p></div>
      <button className="secondary" onClick={onUseClassic}>Use classic Home Screen</button>
    </div>

    {pendingTotal ? <section className="commandAttention">
      <div><span className="eyebrow">Needs your attention</span><h3>{pendingTotal} item{pendingTotal === 1 ? "" : "s"} waiting</h3><p>{pendingTimeOff ? `${pendingTimeOff} time-off request${pendingTimeOff === 1 ? "" : "s"}` : ""}{pendingTimeOff && pendingJobReviews ? " and " : ""}{pendingJobReviews ? `${pendingJobReviews} job review${pendingJobReviews === 1 ? "" : "s"}` : ""} need a decision.</p></div>
      <div className="commandAttentionActions">
        {pendingTimeOff > 0 && <button className="primary" onClick={() => onNavigate("timeoff")}>Review time off</button>}
        {pendingJobReviews > 0 && <button className="primary" onClick={() => onNavigate("jobreviews")}>Review job reviews</button>}
      </div>
    </section> : <div className="commandAttentionEmpty"><strong>All caught up</strong><span>No time-off or job-review decisions are waiting.</span></div>}

    <div className="commandMetrics">
      <div><span>Selected week</span><strong>{totalHours.toFixed(2)} hrs</strong><small>{data.target?.name ?? "Your"} · {data.weekStart ? dateRangeLabel(data.weekStart, data.weekEnd ?? data.weekStart) : "Current week"}</small></div>
      <div><span>Check estimate</span><strong>{money(totalPay)}</strong><small>Based on the selected week&apos;s entries</small></div>
      <div><span>Employees</span><strong>{(data.employees ?? []).length}</strong><small>Active employee records</small></div>
      <div><span>Active jobs</span><strong>{activeJobs}</strong><small>Completed jobs stay in reports</small></div>
    </div>

    <div className="commandActionsHead"><div><span className="eyebrow">Quick actions</span><h3>Jump where you need to go</h3></div></div>
    <div className="commandActions">
      <button className="commandAction" onClick={() => onNavigate("time")}><strong>Time cards</strong><span>Review or correct hours</span></button>
      <button className="commandAction" onClick={() => onNavigate("timeoff")}><strong>Time off</strong><span>{pendingTimeOff ? `${pendingTimeOff} waiting for review` : "Review team availability"}</span>{pendingTimeOff > 0 && <b>{pendingTimeOff}</b>}</button>
      <button className="commandAction" onClick={() => onNavigate("jobreviews")}><strong>Job reviews</strong><span>{pendingJobReviews ? `${pendingJobReviews} possible mismatch${pendingJobReviews === 1 ? "" : "es"}` : "Check possible job mismatches"}</span>{pendingJobReviews > 0 && <b>{pendingJobReviews}</b>}</button>
      <button className="commandAction" onClick={() => onNavigate("reports")}><strong>Pay reports</strong><span>Create or download pay records</span></button>
    </div>

    <div className="betaMarker"><strong>Beta Home Screen</strong><span>Rollback reference: <code>classic-admin-tabs-v26</code>. Use “Use classic Home Screen” anytime if something looks wrong.</span></div>
  </section>;
}

function TimeOff({ data, busy, act }: { data: Data; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const isAdmin = data.user?.role === "admin";
  const [month, setMonth] = useState(() => {
    if (typeof window === "undefined") return today().slice(0, 7);
    const requestedMonth = new URLSearchParams(window.location.search).get("month") ?? "";
    return /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : today().slice(0, 7);
  });
  const [focusRequestId] = useState(() => typeof window === "undefined" ? 0 : Number(new URLSearchParams(window.location.search).get("request")) || 0);
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ startDate: today(), endDate: today(), note: "" });
  const loadedMonthRef = useRef("");
  const handledDecisionRef = useRef(false);

  const loadRequests = useCallback(async () => {
    const changingMonth = loadedMonthRef.current !== month;
    if (changingMonth) { setLoading(true); setError(""); }
    try {
      const result = await api(undefined, `?timeOff=1&month=${encodeURIComponent(month)}`);
      setRequests(result.requests ?? []);
      loadedMonthRef.current = month;
    } catch (cause) {
      if (changingMonth) setError(cause instanceof Error ? cause.message : "Could not load the time-off calendar.");
    } finally { if (changingMonth) setLoading(false); }
  }, [month]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRequests(), 0);
    return () => window.clearTimeout(timer);
  }, [loadRequests, data.syncToken]);

  const calendarDays = useMemo(() => {
    const first = new Date(`${month}-01T12:00:00Z`);
    first.setUTCDate(first.getUTCDate() - first.getUTCDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(first); date.setUTCDate(first.getUTCDate() + index); return iso(date);
    });
  }, [month]);
  const pending = requests.filter((item) => item.status === "pending");
  const calendarRequests = requests.filter((item) => item.status === "approved" || (isAdmin && item.status === "pending"));
  const monthItems = calendarRequests.filter((item) => item.endDate >= `${month}-01` && item.startDate <= `${month}-31`);
  const ownRequests = requests.filter((item) => item.userId === data.user?.id);

  const update = useCallback(async (body: Record<string, unknown>, success: string) => {
    setMessage("");
    if (await act(body)) {
      setMessage(success);
      await loadRequests();
    }
  }, [act, loadRequests]);

  useEffect(() => {
    if (!focusRequestId || !requests.length) return;
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-request-id="${focusRequestId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      const params = new URLSearchParams(window.location.search);
      const decision = params.get("decision");
      const request = requests.find((item) => item.id === focusRequestId);
      if (isAdmin && request?.status === "pending" && (decision === "approved" || decision === "denied") && !handledDecisionRef.current) {
        handledDecisionRef.current = true;
        params.delete("decision");
        window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
        const label = decision === "approved" ? "approve" : "deny";
        if (window.confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} ${request.userName}'s time-off request for ${dateRangeLabel(request.startDate, request.endDate)}?`)) {
          void update({ action: "reviewTimeOff", id: request.id, decision }, `${request.userName}'s request was ${decision}.`);
        }
      }
    }, 100);
    return () => window.clearTimeout(timer);
  }, [focusRequestId, isAdmin, requests, update]);

  return <section>
    <div className="sectionHead timeOffHead">
      <div><span className="eyebrow">Team availability</span><h2>Time off</h2><p className="sectionHint">{isAdmin ? "Review requests and see who will be out before planning the workweek." : "The calendar shows approved team time off. Your requests stay below until Corbin decides."}</p></div>
    </div>
    {error && <div className="alert">{error}</div>}
    {message && <div className="successMessage timeOffMessage">{message}</div>}

    <PhonePush push={data.push} role={isAdmin ? "admin" : "employee"} />

    {isAdmin && <div className="requestSection">
      <div className="requestTitle"><div><span className="eyebrow">Needs a decision</span><h3>Pending requests</h3></div><span className="countBubble">{pending.length}</span></div>
      {pending.length ? <div className="requestList">{pending.map((item) => <article className={`requestCard ${focusRequestId === item.id ? "requestFocused" : ""}`} data-request-id={item.id} key={item.id}>
        <div className="requestCardMain"><div className="requestAvatar">{item.userName.charAt(0).toUpperCase()}</div><div><strong>{item.userName}</strong><span>{dateRangeLabel(item.startDate, item.endDate)}</span>{item.note && <p>{item.note}</p>}</div></div>
        <div className="reviewActions"><button className="secondary" disabled={busy} onClick={() => void update({ action: "reviewTimeOff", id: item.id, decision: "approved" }, `${item.userName}'s request was approved.`)}>Approve</button><button className="danger" disabled={busy} onClick={() => void update({ action: "reviewTimeOff", id: item.id, decision: "denied" }, `${item.userName}'s request was denied.`)}>Deny</button></div>
      </article>)}</div> : <div className="empty compactEmpty"><p>No requests are waiting.</p></div>}
    </div>}

    {!isAdmin && <form className="requestForm" onSubmit={async (event) => {
      event.preventDefault();
      if (await act({ action: "requestTimeOff", ...form })) {
        setMessage("Your request was sent to Corbin.");
        setForm({ startDate: today(), endDate: today(), note: "" });
        await loadRequests();
      }
    }}>
      <div><span className="eyebrow">New request</span><h3>Ask for time off</h3></div>
      <div className="dateFields"><label>First day<input type="date" min={today()} value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value, endDate: event.target.value > form.endDate ? event.target.value : form.endDate })} required /></label><label>Last day<input type="date" min={form.startDate || today()} value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} required /></label></div>
      <label>Note <span className="optional">(optional)</span><textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} maxLength={500} rows={3} placeholder="Anything Corbin should know" /></label>
      <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send request"}</button>
    </form>}

    <div className="calendarPanel">
      <div className="calendarHead"><button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button><div><span className="eyebrow">Calendar</span><h3>{monthLabel(month)}</h3></div><button onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button></div>
      {loading ? <div className="calendarLoading"><div className="spinner" /><span>Loading calendar…</span></div> : <>
        <div className="calendarWeekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="monthGrid">{calendarDays.map((date) => {
          const events = calendarRequests.filter((item) => item.startDate <= date && item.endDate >= date);
          return <div className={`calendarDay ${date.slice(0, 7) !== month ? "outsideMonth" : ""} ${date === today() ? "today" : ""}`} key={date}>
            <span className="dayNumber">{Number(date.slice(8))}</span>
            <div className="calendarEvents">{events.slice(0, 3).map((item) => <span className={`calendarEvent ${item.status}`} key={item.id} title={`${item.userName}: ${item.status}`}>{item.userName}</span>)}{events.length > 3 && <span className="moreEvents">+{events.length - 3}</span>}</div>
          </div>;
        })}</div>
      </>}
      <div className="calendarLegend"><span><i className="legendApproved" />Approved</span>{isAdmin && <span><i className="legendPending" />Pending</span>}</div>
    </div>

    <div className="agendaSection">
      <div><span className="eyebrow">At a glance</span><h3>{isAdmin ? "This month's time off" : "Team time off"}</h3></div>
      <div className="agendaList">{monthItems.length ? monthItems.map((item) => <article className={`agendaItem ${focusRequestId === item.id ? "requestFocused" : ""}`} data-request-id={item.id} key={item.id}><div><strong>{item.userName}</strong><span>{dateRangeLabel(item.startDate, item.endDate)}</span></div><Status status={item.status} /></article>) : <div className="empty compactEmpty"><p>{isAdmin ? "No time off on this month’s calendar." : "No approved team time off this month."}</p></div>}</div>
    </div>

    {!isAdmin && <div className="agendaSection">
      <div><span className="eyebrow">Your requests</span><h3>Request history</h3></div>
      <div className="agendaList">{ownRequests.length ? ownRequests.map((item) => <article className={`agendaItem requestHistory ${focusRequestId === item.id ? "requestFocused" : ""}`} data-request-id={item.id} key={item.id}><div><strong>{dateRangeLabel(item.startDate, item.endDate)}</strong><span>{item.note || "No note"}</span>{item.reviewNote && <small>Corbin: {item.reviewNote}</small>}</div><div className="historyActions"><Status status={item.status} />{item.status === "pending" && <button className="textButton cancelRequest" disabled={busy} onClick={() => void update({ action: "cancelTimeOff", id: item.id }, "Your request was cancelled.")}>Cancel</button>}</div></article>) : <div className="empty compactEmpty"><p>You have not requested any time off yet.</p></div>}</div>
    </div>}
  </section>;
}

function Status({ status }: { status: TimeOffRequest["status"] }) {
  return <span className={`status status-${status}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

function PhonePush({ push, role }: { push?: Data["push"]; role: "admin" | "employee" }) {
  const [enabled, setEnabled] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const configure = useCallback((requestPermission: boolean) => {
    if (!push?.configured || !push.appId || !push.externalId) return;
    setWorking(true); setError("");
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async (oneSignal) => {
      try {
        if (!window.__timeCardPushInitialized) {
          await oneSignal.init({
            appId: push.appId,
            ...(push.safariWebId ? { safari_web_id: push.safariWebId } : {}),
            serviceWorkerPath: "/push/onesignal/OneSignalSDKWorker.js",
            serviceWorkerParam: { scope: "/push/onesignal/" },
          });
          window.__timeCardPushInitialized = true;
        }
        await oneSignal.login(push.externalId!);
        if (requestPermission) await oneSignal.Notifications.requestPermission();
        setEnabled(Boolean(oneSignal.Notifications.permission));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Phone notifications could not be enabled.");
      } finally { setWorking(false); }
    });
  }, [push]);

  useEffect(() => {
    const timer = window.setTimeout(() => configure(false), 0);
    return () => window.clearTimeout(timer);
  }, [configure]);

  if (!push?.configured) return <aside className="pushCard pushOffline"><div className="pushIcon" aria-hidden="true">↗</div><div><strong>Push notifications are ready to connect</strong><p>{role === "admin" ? "The calendar works now. Connect OneSignal to turn on request notifications and day-before reminders." : "Time-off decision notifications will be available after OneSignal is connected."}</p></div></aside>;
  const fullyConnected = enabled && push.sendingConfigured;
  const title = fullyConnected
    ? role === "admin" ? "Push notifications are on" : "Time-off push notifications are on"
    : enabled ? "Push subscription is on"
    : "Enable push notifications";
  const description = fullyConnected
    ? role === "admin" ? "New requests and day-before reminders can appear on this phone." : "Approvals and denials can appear on this phone as soon as Corbin responds."
    : enabled ? "The phone is subscribed. Notification sending still needs to be connected."
    : "On iPhone, open the installed Home Screen app and allow notifications.";
  return <aside className="pushCard"><div className="pushIcon" aria-hidden="true">●</div><div><strong>{title}</strong><p>{description}</p>{error && <span className="pushError">{error}</span>}</div>{!enabled && <button className="primary compact" disabled={working} onClick={() => configure(true)}>{working ? "Connecting…" : "Enable push notifications"}</button>}</aside>;
}

function PayWeekStatus({ isAdmin, paid, received, paymentDate, paymentMethod, checkNumber, userId, weekStart, busy, act }: {
  isAdmin: boolean; paid: boolean; received: boolean; paymentDate: string; paymentMethod: string; checkNumber: string;
  userId: number; weekStart: string; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [number, setNumber] = useState(checkNumber);
  const [date, setDate] = useState(paymentDate);
  const [method, setMethod] = useState(paymentMethod);
  const [saved, setSaved] = useState(false);
  const save = async (nextPaid = paid) => {
    setSaved(false);
    const nextDate = nextPaid && !date ? today() : date;
    if (nextDate !== date) setDate(nextDate);
    if (await act({ action: "setPaid", userId, weekStart, ...(isAdmin
      ? { paid: nextPaid, paymentDate: nextDate, paymentMethod: method, checkNumber: number }
      : { received: nextPaid }) })) setSaved(true);
  };
  return <div className="payWeekStatus">
    <label className="paidCheck"><input type="checkbox" checked={isAdmin ? paid : received} disabled={busy} onChange={(event) => void save(event.target.checked)} /> {isAdmin ? "Payment issued" : "Payment received"}</label>
    {isAdmin ? <div className="checkNumberEdit paymentDetailsEdit">
      <label>Payment date <span>(optional)</span><input type="date" value={date} onChange={(event) => { setDate(event.target.value); setSaved(false); }} /></label>
      <label>Method <span>(optional)</span><select value={method} onChange={(event) => { setMethod(event.target.value); setSaved(false); }}><option value="">Not listed</option><option value="Check">Check</option><option value="Cash">Cash</option><option value="Direct deposit">Direct deposit</option><option value="Other">Other</option></select></label>
      <label>Check # <span>(optional)</span><input value={number} onChange={(event) => { setNumber(event.target.value.slice(0, 40)); setSaved(false); }} placeholder="Leave blank" /></label>
      <button className="summarySave" disabled={busy || (number === checkNumber && date === paymentDate && method === paymentMethod)} onClick={() => void save()}>{saved ? "Saved" : "Save details"}</button>
      <small>{received ? "Employee confirmed receipt" : "Awaiting employee receipt confirmation"}</small>
    </div> : <small>{paid ? `Issued${paymentDate ? ` ${reportDate(paymentDate)}` : ""}${paymentMethod ? ` · ${paymentMethod}` : ""}${checkNumber ? ` · Check #${checkNumber}` : ""}` : "Corbin has not marked this payment issued yet."}</small>}
  </div>;
}

const paySummaryFilename = (report: PayReportData) => {
  const name = report.employee.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "employee";
  return `pay-summary-${name}-${report.startDate}-to-${report.endDate}.pdf`;
};

async function createPaySummaryPdf(report: PayReportData) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const weeks = reportWeeks(report);
  const totalHours = report.entries.reduce((sum, entry) => sum + Number(entry.hours), 0);
  const totalPay = report.entries.reduce((sum, entry) => sum + Number(entry.hours) * Number(entry.hourlyRate), 0);
  const ratesUsed = rateList(report.entries.length ? report.entries.map((entry) => Number(entry.hourlyRate)) : [Number(report.employee.hourlyRate)]);
  const jobTotals = new Map<string, number>();
  report.entries.forEach((entry) => jobTotals.set(entry.job, (jobTotals.get(entry.job) ?? 0) + Number(entry.hours)));
  const margin = 46;
  const pageWidth = 612;
  const pageBottom = 738;

  const brandHeader = (continued = false) => {
    doc.setFillColor(23, 76, 53); doc.rect(0, 0, pageWidth, continued ? 58 : 102, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(continued ? 15 : 12);
    doc.text("HAZEN CONSTRUCTION", margin, continued ? 35 : 34);
    if (!continued) { doc.setFontSize(23); doc.text("Employee Pay Summary", margin, 69); }
    doc.setTextColor(23, 35, 29);
  };
  const tableHeader = (y: number) => {
    doc.setFillColor(237, 242, 238); doc.rect(margin, y - 13, pageWidth - margin * 2, 22, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(50, 70, 60);
    doc.text("WEEK STARTING", margin + 6, y); doc.text("HOURS", 240, y, { align: "right" }); doc.text("RATE(S)", 322, y, { align: "right" }); doc.text("GROSS PAY", 409, y, { align: "right" }); doc.text("PAYMENT", pageWidth - margin - 6, y, { align: "right" });
    return y + 22;
  };

  brandHeader();
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.text(report.employee.name, margin, 132);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(101, 115, 107);
  doc.text(`${reportDate(report.startDate)} – ${reportDate(report.endDate)}`, margin, 150);
  doc.setFillColor(242, 248, 244); doc.roundedRect(margin, 170, pageWidth - margin * 2, 68, 8, 8, "F");
  doc.setTextColor(101, 115, 107); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  doc.text("TOTAL HOURS", margin + 14, 191); doc.text("HOURLY RATE USED", 220, 191); doc.text("CALCULATED GROSS PAY", 382, 191);
  doc.setTextColor(23, 76, 53); doc.setFontSize(15);
  doc.text(totalHours.toFixed(2), margin + 14, 217); doc.text(rateLabel(ratesUsed), 220, 217); doc.text(money(totalPay), 382, 217);

  doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(23, 35, 29); doc.text("Weekly breakdown", margin, 270);
  let y = tableHeader(292);
  doc.setFontSize(9);
  weeks.forEach((week) => {
    if (y > pageBottom - 28) { doc.addPage(); brandHeader(true); doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.text("Weekly breakdown (continued)", margin, 84); y = tableHeader(108); }
    doc.setFont("helvetica", "normal"); doc.setTextColor(23, 35, 29);
    doc.text(reportDate(week.weekStart), margin + 6, y); doc.text(week.hours.toFixed(2), 240, y, { align: "right" }); doc.text(rateLabel(week.rates), 322, y, { align: "right" }); doc.text(money(week.pay), 409, y, { align: "right" });
    doc.setFontSize(7);
    const payment = doc.splitTextToSize(paymentSummary(week), 126);
    doc.text(payment, pageWidth - margin - 6, y, { align: "right" });
    const rowHeight = Math.max(22, payment.length * 8 + 8);
    doc.setDrawColor(226, 229, 224); doc.line(margin, y + rowHeight - 14, pageWidth - margin, y + rowHeight - 14); y += rowHeight;
    doc.setFontSize(9);
  });
  if (!weeks.length) { doc.setFont("helvetica", "normal"); doc.setTextColor(101, 115, 107); doc.text("No hours were recorded during this period.", margin + 6, y); y += 26; }

  if (y > pageBottom - 120) { doc.addPage(); brandHeader(true); y = 86; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(23, 35, 29); doc.text("Hours by job", margin, y); y += 23;
  [...jobTotals.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([job, hours]) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(job, margin + 6, y); doc.text(`${hours.toFixed(2)} hrs`, pageWidth - margin - 6, y, { align: "right" }); y += 18;
  });
  if (!jobTotals.size) { doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(101, 115, 107); doc.text("No job activity", margin + 6, y); y += 18; }

  if (y > pageBottom - 72) { doc.addPage(); brandHeader(true); y = 88; }
  doc.setDrawColor(210, 216, 211); doc.line(margin, y + 8, pageWidth - margin, y + 8);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(101, 115, 107);
  const note = "Internal pay summary only — not an official W-2 or 1099. Calculated gross pay applies the stored rate effective on each work date. Verify against issued payments before tax filing.";
  doc.text(doc.splitTextToSize(note, pageWidth - margin * 2), margin, y + 27);
  doc.text(`Generated ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.generatedAt))}`, margin, y + 57);
  return doc.output("blob");
}

function PayReports({ people, isAdmin, selectedWeek }: { people: Person[]; isAdmin: boolean; selectedWeek: string }) {
  const year = Number(today().slice(0, 4));
  const [employeeId, setEmployeeId] = useState(people[0]?.id ?? 0);
  const [preset, setPreset] = useState(isAdmin ? "ytd" : "week");
  const [startDate, setStartDate] = useState(isAdmin ? `${year}-01-01` : selectedWeek);
  const [endDate, setEndDate] = useState(isAdmin ? today() : addDays(selectedWeek, 6));
  const [report, setReport] = useState<PayReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const choosePreset = (value: string) => {
    setPreset(value); setReport(null);
    if (value === "week") { setStartDate(selectedWeek); setEndDate(addDays(selectedWeek, 6)); }
    if (value === "ytd") { setStartDate(`${year}-01-01`); setEndDate(today()); }
    if (value === "last") { setStartDate(`${year - 1}-01-01`); setEndDate(`${year - 1}-12-31`); }
  };
  const generate = async () => {
    setLoading(true); setError("");
    try { setReport(await api(undefined, `?report=pay&employeeId=${employeeId}&startDate=${startDate}&endDate=${endDate}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The pay report could not be created."); }
    finally { setLoading(false); }
  };
  const downloadPdf = async () => {
    if (!report) return;
    setCreating(true); setError("");
    try {
      const blob = await createPaySummaryPdf(report); const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = paySummaryFilename(report); link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The PDF could not be created."); }
    finally { setCreating(false); }
  };
  const openPdf = async () => {
    if (!report) return;
    const popup = window.open("about:blank", "_blank"); setCreating(true); setError("");
    try {
      const blob = await createPaySummaryPdf(report); const url = URL.createObjectURL(blob);
      if (popup) popup.location.href = url; else { const link = document.createElement("a"); link.href = url; link.download = paySummaryFilename(report); link.click(); }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { popup?.close(); setError(cause instanceof Error ? cause.message : "The PDF could not be opened."); }
    finally { setCreating(false); }
  };
  const sharePdf = async () => {
    if (!report) return;
    setCreating(true); setError("");
    try {
      const blob = await createPaySummaryPdf(report); const file = new File([blob], paySummaryFilename(report), { type: "application/pdf" });
      const shareData = { title: `${report.employee.name} pay summary`, text: `Hazen Construction pay summary for ${reportDate(report.startDate)} through ${reportDate(report.endDate)}.`, files: [file] };
      if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) await navigator.share(shareData);
      else { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = file.name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (cause) { if (cause instanceof Error && cause.name !== "AbortError") setError(cause.message || "The PDF could not be shared."); }
    finally { setCreating(false); }
  };
  const weeks = report ? reportWeeks(report) : [];
  const totalHours = report?.entries.reduce((sum, entry) => sum + Number(entry.hours), 0) ?? 0;
  const totalPay = report?.entries.reduce((sum, entry) => sum + Number(entry.hours) * Number(entry.hourlyRate), 0) ?? 0;
  const ratesUsed = report ? rateList(report.entries.length ? report.entries.map((entry) => Number(entry.hourlyRate)) : [Number(report.employee.hourlyRate)]) : [];
  const csvUrl = report ? `/api/timecard?download=pay-report&employeeId=${report.employee.id}&startDate=${report.startDate}&endDate=${report.endDate}` : "#";

  return <section>
    <div className="sectionHead"><div><span className="eyebrow">{isAdmin ? "Administration" : "Your records"}</span><h2>{isAdmin ? "Pay reports" : "Pay history"}</h2><p className="sectionHint">{isAdmin ? "Create an internal pay summary for an employee, then download, print, or email the PDF from your phone." : "View your recorded hours and calculated gross pay, then download, print, or share a pay statement from your phone."}</p></div></div>
    <div className="reportBuilder">
      {isAdmin && <label>Employee<select value={employeeId} onChange={(event) => { setEmployeeId(Number(event.target.value)); setReport(null); }}>{people.map((person) => <option key={person.id} value={person.id}>{person.name}{person.archived ? " (removed)" : ""}</option>)}</select></label>}
      <label>Period<select value={preset} onChange={(event) => choosePreset(event.target.value)}><option value="week">Selected time-card week</option><option value="ytd">This year to date</option><option value="last">Last year</option><option value="custom">Custom dates</option></select></label>
      <label>Start date<input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setPreset("custom"); setReport(null); }} /></label>
      <label>End date<input type="date" min={startDate} value={endDate} onChange={(event) => { setEndDate(event.target.value); setPreset("custom"); setReport(null); }} /></label>
      <button className="primary generateReport" disabled={loading || !employeeId || !startDate || !endDate || endDate < startDate} onClick={() => void generate()}>{loading ? "Generating…" : "Generate report"}</button>
    </div>
    {error && <div className="alert">{error}</div>}
    {!people.length ? <div className="empty compactEmpty"><p>Add an employee before creating a pay report.</p></div> : !report ? <div className="reportEmpty"><span aria-hidden="true">▤</span><h3>Ready when you are</h3><p>{isAdmin ? "Choose an employee and period, then generate the report." : "Choose a period, then generate your pay statement."}</p></div> : <div className="reportPreview">
      <div className="reportPreviewHead"><div><span className="eyebrow">Hazen Construction</span><h3>{report.employee.name}</h3><p>{reportDate(report.startDate)} – {reportDate(report.endDate)}</p></div><span className="reportBadge">Pay summary</span></div>
      <div className="reportTotals"><div><span>Total hours</span><strong>{totalHours.toFixed(2)}</strong></div><div><span>{ratesUsed.length > 1 ? "Rates used" : "Rate used"}</span><strong>{rateLabel(ratesUsed)}</strong></div><div><span>Calculated gross pay</span><strong>{money(totalPay)}</strong></div></div>
      <div className="reportActions"><button className="primary" disabled={creating} onClick={() => void sharePdf()}>{creating ? "Preparing…" : "Share / email PDF"}</button><button className="secondary" disabled={creating} onClick={() => void openPdf()}>Open / print PDF</button><button className="secondary" disabled={creating} onClick={() => void downloadPdf()}>Download PDF</button><a className="secondary downloadButton" href={csvUrl}>Download CSV</a></div>
      <div className="reportTableWrap"><table className="reportTable"><thead><tr><th>Week starting</th><th>Hours</th><th>Rate(s)</th><th>Gross pay</th><th>Payment</th></tr></thead><tbody>{weeks.length ? weeks.map((item) => <tr key={item.weekStart}><td>{reportDate(item.weekStart)}</td><td>{item.hours.toFixed(2)}</td><td>{rateLabel(item.rates)}</td><td>{money(item.pay)}</td><td>{paymentSummary(item)}</td></tr>) : <tr><td colSpan={5}>No hours recorded in this period.</td></tr>}</tbody></table></div>
      <p className="reportDisclaimer">This is an internal pay summary, not an official W-2 or 1099. The calculation automatically applies the stored hourly rate effective on each work date and should still be checked against issued payments before tax filing.</p>
    </div>}
  </section>;
}

function JobHoursReport() {
  const [report, setReport] = useState<JobHoursReportData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api(undefined, "?report=job-hours")
      .then((result) => { if (active) setReport(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "The job-hours report could not be loaded."); });
    return () => { active = false; };
  }, []);
  const jobs = report?.jobs ?? [];
  const totalHours = jobs.reduce((sum, job) => sum + Number(job.totalHours), 0);

  return <section>
    <div className="sectionHead"><div><span className="eyebrow">Administration</span><h2>Job hours</h2><p className="sectionHint">All recorded hours for each job, with a breakdown of who worked them.</p></div></div>
    {error && <div className="alert">{error}</div>}
    {!report ? <div className="reportEmpty"><span aria-hidden="true">◷</span><h3>Loading job hours…</h3></div> : <>
      <div className="jobHoursSummary"><span>All jobs</span><strong>{totalHours.toFixed(2)} hours</strong></div>
      <div className="jobHoursList">
        {jobs.length ? jobs.map((job) => <article className={`jobHoursCard ${job.active ? "" : "completedJobHours"}`} key={job.id}>
          <header><div><h3>{job.name}</h3>{!job.active && <span className="jobStatus">Complete</span>}</div><strong>{job.totalHours.toFixed(2)} hours</strong></header>
          <div className="jobHoursPeople">
            {job.people.length ? job.people.map((person) => <div key={person.id}><span>{person.name}{person.archived ? " (removed)" : ""}</span><strong>{person.hours.toFixed(2)}</strong></div>) : <p>No hours recorded.</p>}
          </div>
        </article>) : <div className="empty compactEmpty"><p>No jobs have been added yet.</p></div>}
      </div>
    </>}
  </section>;
}

function History({ week, employeeId }: { week: string; employeeId: number }) {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api(undefined, "?history=1").then((result) => setItems(result.history ?? [])).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load history."));
  }, []);
  const when = (value: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  return <section>
    <div className="sectionHead">
      <div><span className="eyebrow">Records</span><h2>History & backup</h2><p className="sectionHint">HazenTime creates a private recovery backup every day and retains 45 days. You can also download a weekly payroll CSV or a manual backup anytime.</p></div>
    </div>
    <div className="backupActions">
      <a className="primary downloadButton" href={`/api/timecard?download=csv&week=${encodeURIComponent(week)}&employeeId=${employeeId}`}>Download selected week CSV</a>
      <a className="secondary downloadButton" href="/api/timecard?download=backup">Download complete backup</a>
    </div>
    {error && <div className="alert">{error}</div>}
    <div className="historyList">
      {items.length ? items.map((item) => <article className="historyItem" key={item.id}>
        <div><strong>{item.summary}</strong><span>{item.actorName} · {when(item.createdAt)}</span></div>
        <span className="historyType">{item.targetType.replaceAll("_", " ")}</span>
      </article>) : <div className="empty compactEmpty"><p>No changes have been recorded yet.</p></div>}
    </div>
  </section>;
}

function Setup({ busy, error, onSubmit }: { busy: boolean; error: string; onSubmit: (name: string, pin: string) => void }) {
  const [name, setName] = useState(""); const [pin, setPin] = useState("");
  return <main className="authPage"><div className="authCard"><span className="eyebrow">Hazen Construction</span><h1>Set up your time cards</h1><p>Create the first administrator. You’ll use this name and 6-digit PIN to manage employees, jobs, and payroll.</p>{error && <div className="alert">{error}</div>}<form onSubmit={(event) => { event.preventDefault(); onSubmit(name, pin); }}><label>Administrator name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></label><label>6-digit PIN<input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" pattern="\d{6}" required /></label><button className="primary" disabled={busy}>{busy ? "Saving…" : "Create administrator"}</button></form></div></main>;
}

function Login({ data, selected, setSelected, busy, error, onLogin }: { data: Data; selected: { id: number; name: string; kind: string } | null; setSelected: (value: { id: number; name: string; kind: string } | null) => void; busy: boolean; error: string; onLogin: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const people = [...(data.employees ?? []).map((p) => ({ ...p, kind: "Employee" })), ...(data.admins ?? []).map((p) => ({ ...p, kind: "Administrator" }))];
  return <main className="authPage"><div className="loginWrap"><span className="eyebrow">Hazen Construction</span>{selected && <h1>Hi, {selected.name}</h1>}{!selected ? <div className="personGrid">{people.map((person) => <button key={`${person.kind}-${person.id}`} className="personCard" onClick={() => setSelected(person)}><span className="avatar">{person.name.charAt(0).toUpperCase()}</span><strong>{person.name}</strong></button>)}</div> : <form className="pinForm" onSubmit={(event) => { event.preventDefault(); onLogin(pin); }}><p>Enter your PIN to continue.</p>{error && <div className="alert">{error}</div>}<input aria-label="PIN" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" placeholder="••••••" /><button className="primary" disabled={busy || pin.length < 4}>{busy ? "Checking…" : "Continue"}</button><button type="button" className="textButton" onClick={() => { setPin(""); setSelected(null); }}>Choose someone else</button></form>}</div></main>;
}

function TimeGrid({ week, jobs, entries, targetId, isAdmin, busy, act, onEditorClose }: { week: string; jobs: Job[]; entries: Entry[]; targetId: number; isAdmin: boolean; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean>; onEditorClose: () => void }) {
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState(0);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  const openEntries = openDate ? entries.filter((entry) => entry.workDate === openDate) : [];
  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  const selectedEntry = openEntries.find((entry) => entry.jobId === selectedJobId);
  const selectableJobs = isAdmin ? jobs : jobs.filter((job) => Boolean(job.active));
  const openHours = openEntries.reduce((sum, entry) => sum + Number(entry.hours), 0);
  const closeEditor = useCallback(() => { setOpenDate(null); setSelectedJobId(0); onEditorClose(); }, [onEditorClose]);
  const editDay = (date: string) => {
    const dayEntries = entries.filter((entry) => entry.workDate === date);
    setOpenDate(date);
    setSelectedJobId(dayEntries[0]?.jobId ?? 0);
  };

  useEffect(() => {
    if (!openDate) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeEditor(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeEditor, openDate]);

  return <>
    <p className="timeCalendarHint">Tap a day to add or edit time.</p>
    <section className="timeCalendar" aria-label="Weekly time card calendar">
      <div className="timeCalendarWeekdays" aria-hidden="true">
        {days.map((date) => <span key={date}>{new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}</span>)}
      </div>
      <div className="timeCalendarGrid">
        {days.map((date) => {
          const dayEntries = entries.filter((entry) => entry.workDate === date);
          const dayHours = dayEntries.reduce((sum, entry) => sum + Number(entry.hours), 0);
          const flagged = dayEntries.some((entry) => entry.flagged && !entry.resolved);
          return <button
            type="button"
            className={`timeDay ${dayHours > 0 ? "hasTime" : ""} ${date === today() ? "today" : ""}`}
            key={date}
            aria-label={`${dayLabel(date)}, ${dayHours.toFixed(2)} hours. Add or edit time.`}
            onClick={() => editDay(date)}
          >
            <span className="timeDayNumber">{Number(date.slice(-2))}</span>
            <strong className="timeDayHours">{dayHours.toFixed(2)}<small> hrs</small></strong>
            <span className="timeDayMeta">{dayEntries.length ? `${dayEntries.length} ${dayEntries.length === 1 ? "job" : "jobs"}` : "Add time"}{flagged ? <i title="Needs attention">!</i> : null}</span>
          </button>;
        })}
      </div>
    </section>

    {openDate && <div className="timeModalBackdrop" onClick={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
      <section className="timeModal" role="dialog" aria-modal="true" aria-labelledby="time-editor-title">
        <header className="timeModalHead">
          <div><span className="eyebrow">Time entry</span><h3 id="time-editor-title">{dayLabel(openDate)}</h3><p>{openHours.toFixed(2)} hours logged</p></div>
          <button type="button" className="modalClose" aria-label="Close time entry" onClick={closeEditor}>×</button>
        </header>
        <div className="timeModalBody">
          {openEntries.length > 0 && <div className="loggedEntries">
            <span className="loggedLabel">Logged this day</span>
            {openEntries.map((entry) => {
              const job = jobs.find((item) => item.id === entry.jobId);
              if (!job) return null;
              return <button type="button" className={`loggedEntry ${selectedJobId === job.id ? "selected" : ""}`} key={entry.id} onClick={() => setSelectedJobId(job.id)}>
                <span>{job.name}{entry.flagged ? " ⚑" : ""}</span><strong>{Number(entry.hours).toFixed(2)} hrs</strong>
              </button>;
            })}
          </div>}
          <label className="jobPicker">Job
            <select value={selectedJobId || ""} onChange={(event) => setSelectedJobId(Number(event.target.value))}>
              <option value="">Choose a job…</option>
              {selectableJobs.map((job) => <option key={job.id} value={job.id}>{job.name}{!job.active ? " (complete)" : ""}</option>)}
            </select>
          </label>
          {selectedJob ? <EntryRow key={`${selectedJob.id}-${JSON.stringify(selectedEntry)}`} date={openDate} job={selectedJob} jobs={jobs} entry={selectedEntry} dayEntries={openEntries} targetId={targetId} isAdmin={isAdmin} busy={busy} act={act} onSaved={closeEditor} /> :
            <p className="chooseJobHint">Choose a job to add or edit time.</p>}
        </div>
      </section>
    </div>}
  </>;
}

function EntryRow({ date, job, jobs, entry, dayEntries, targetId, isAdmin, busy, act, onSaved }: { date: string; job: Job; jobs: Job[]; entry?: Entry; dayEntries: Entry[]; targetId: number; isAdmin: boolean; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean>; onSaved?: () => void }) {
  const [hours, setHours] = useState(entry?.hours ? String(entry.hours) : "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [flagged, setFlagged] = useState(Boolean(entry?.flagged));
  const [flagReason, setFlagReason] = useState(entry?.flagReason ?? "");
  const [resolution, setResolution] = useState(entry?.resolution ?? "");
  const [resolved, setResolved] = useState(Boolean(entry?.resolved));
  const [moveJobId, setMoveJobId] = useState(0);
  const hasContent = Boolean(hours || note.trim() || flagged);
  const canEdit = isAdmin || Boolean(job.active);
  const canSave = canEdit && (hasContent || Boolean(entry));
  const save = async () => {
    const numericHours = Number(hours) || 0;
    const otherHours = dayEntries.filter((item) => item.jobId !== job.id).reduce((sum, item) => sum + Number(item.hours), 0);
    const warnings = hasContent ? [
      ...(date > today() ? ["This date is in the future."] : []),
      ...(otherHours + numericHours > 24 ? [`The day would total ${(otherHours + numericHours).toFixed(2)} hours.`] : []),
    ] : [];
    if (warnings.length && !window.confirm(`${warnings.join("\n")}\n\nSave it anyway?`)) return;
    if (await act({ action: "saveEntry", userId: targetId, jobId: job.id, workDate: date, hours: numericHours, note, flagged, flagReason, warningsAccepted: warnings.length > 0 })) onSaved?.();
  };
  const moveEntry = async () => {
    if (!entry || !moveJobId) return;
    const destination = jobs.find((item) => item.id === moveJobId);
    if (!destination || !window.confirm(`Move this ${Number(entry.hours).toFixed(2)}-hour entry from ${job.name} to ${destination.name}?`)) return;
    if (await act({ action: "moveEntry", entryId: entry.id, jobId: moveJobId })) onSaved?.();
  };
  return <div className={`entryRow ${flagged ? "isFlagged" : ""}`}>
    <div className="entryMain"><strong>{job.name}{!job.active ? " (complete)" : ""}</strong><label className="hoursField"><span>Hours</span><input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" type="number" min="0" max="24" step=".25" placeholder="0" disabled={!canEdit} /></label></div>
    {!canEdit && <p className="completedEntryNotice">This job is complete. Ask Corbin if this time needs changed.</p>}
    <label>Note<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional work note" rows={2} disabled={!canEdit} /></label>
    <label className="flagCheck"><input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} disabled={!canEdit} /> Flag this entry</label>
    {flagged && <label>Why is it flagged?<textarea value={flagReason} onChange={(e) => setFlagReason(e.target.value)} placeholder="Explain what needs attention" rows={2} disabled={!canEdit} /></label>}
    {isAdmin && entry && <div className="moveEntry"><label>Move hours to another job<select value={moveJobId || ""} onChange={(event) => setMoveJobId(Number(event.target.value))}><option value="">Choose destination…</option>{jobs.filter((item) => item.id !== job.id).map((item) => <option key={item.id} value={item.id}>{item.name}{!item.active ? " (complete)" : ""}</option>)}</select></label><button className="secondary" disabled={busy || !moveJobId} onClick={() => void moveEntry()}>Move hours</button></div>}
    {isAdmin && entry?.flagged ? <div className="resolution"><label>Resolution comment<textarea value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="What was decided?" rows={2} /></label><label className="flagCheck"><input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /> Resolved</label><button className="secondary" disabled={busy} onClick={() => void act({ action: "resolve", entryId: entry.id, resolution, resolved })}>Save resolution</button></div> : null}
    {canSave && <button className="primary saveEntry" disabled={busy || (flagged && !flagReason.trim())} onClick={() => void save()}>{busy ? "Saving…" : hasContent ? `Save ${job.name}` : `Remove ${job.name} time`}</button>}
  </div>;
}

function People({ people, archivedPeople, busy, act }: { people: Person[]; archivedPeople: Person[]; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const blank = { id: 0, name: "", phone: "", hourlyRate: "", effectiveDate: today(), pin: "" };
  const [editing, setEditing] = useState(blank);
  return <section>
    <div className="sectionHead"><div><span className="eyebrow">Administration</span><h2>Employees</h2><p className="sectionHint">Removing an employee turns off sign-in and hides them from active time cards. Their time, pay, and time-off records stay preserved and can still be reported or restored.</p></div><button className="primary compact" onClick={() => setEditing(blank)}>Add employee</button></div>
    <div className="management">
      <form className="editorCard" onSubmit={async (event) => {
        event.preventDefault();
        if (await act({ action: "saveEmployee", ...editing, hourlyRate: Number(editing.hourlyRate) || 0 })) setEditing(blank);
      }}>
        <h3>{editing.id ? "Edit employee" : "New employee"}</h3>
        <label>Name<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} required /></label>
        <label>Phone<input value={editing.phone} onChange={(event) => setEditing({ ...editing, phone: event.target.value })} inputMode="tel" /></label>
        <label>Hourly pay<span className="currencyField"><span aria-hidden="true">$</span><input aria-label="Hourly pay in dollars" value={editing.hourlyRate} onChange={(event) => setEditing({ ...editing, hourlyRate: event.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1") })} onBlur={() => editing.hourlyRate && setEditing({ ...editing, hourlyRate: Number(editing.hourlyRate).toFixed(2) })} inputMode="decimal" placeholder="0.00" /></span></label>
        <label>{editing.id ? "New rate effective date" : "Starting rate effective date"}<input type="date" max={today()} value={editing.effectiveDate} onChange={(event) => setEditing({ ...editing, effectiveDate: event.target.value })} required /><span className="fieldHint">Only used when the hourly rate changes.</span></label>
        <label>{editing.id ? "New PIN (leave blank to keep)" : "PIN"}<input value={editing.pin} onChange={(event) => setEditing({ ...editing, pin: event.target.value.replace(/\D/g, "").slice(0, 6) })} inputMode="numeric" type="password" required={!editing.id} /></label>
        <button className="primary" disabled={busy}>Save employee</button>
      </form>
      <div className="employeeLists">
        <div className="itemList">{people.map((person) => <div className="listItem" key={person.id}><div><strong>{person.name}</strong><span>{person.phone || "No phone"} · {money(Number(person.hourlyRate ?? 0))}/hr</span></div><div><button className="secondary" onClick={() => setEditing({ ...blank, ...person, hourlyRate: Number(person.hourlyRate ?? 0).toFixed(2), effectiveDate: today() })}>Edit</button><button className="danger" onClick={() => { if (confirm(`Remove ${person.name} from active employees? Their records will be preserved and they can be restored later.`)) void act({ action: "archiveEmployee", id: person.id }); }}>Remove</button></div></div>)}</div>
        {archivedPeople.length > 0 && <div className="archivedEmployees"><div><span className="eyebrow">Preserved records</span><h3>Removed employees</h3><p>These people cannot sign in, but their history is still available in Pay reports.</p></div><div className="itemList">{archivedPeople.map((person) => <div className="listItem archivedItem" key={person.id}><div><strong>{person.name}</strong><span>{person.phone || "No phone"} · Records preserved</span></div><div><button className="secondary" disabled={busy} onClick={() => void act({ action: "restoreEmployee", id: person.id })}>Restore</button></div></div>)}</div></div>}
      </div>
    </div>
  </section>;
}

function JobMismatchReviews({ busy, act }: { busy: boolean; act: (body: Record<string, unknown>, reload?: boolean) => Promise<boolean> }) {
  const [result, setResult] = useState<{ reviews: JobMismatchReview[]; jobs: Job[] } | null>(null);
  const [otherJobs, setOtherJobs] = useState<Record<number, number>>({});
  const [message, setMessage] = useState("");
  const focusedId = Number(new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("review"));
  const loadReviews = useCallback(async () => {
    const next = await api(undefined, "?jobReviews=1") as { reviews: JobMismatchReview[]; jobs: Job[] };
    setResult(next);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadReviews(), 0);
    return () => window.clearTimeout(timer);
  }, [loadReviews]);

  useEffect(() => {
    if (!focusedId || !result?.reviews.some((review) => review.id === focusedId)) return;
    const timer = window.setTimeout(() => document.getElementById(`job-review-${focusedId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    return () => window.clearTimeout(timer);
  }, [focusedId, result]);

  const resolveReview = async (review: JobMismatchReview, decision: "jobA" | "jobB" | "other" | "separate") => {
    const selectedJobId = decision === "other" ? Number(otherJobs[review.id]) : undefined;
    const selectedJob = result?.jobs.find((job) => job.id === selectedJobId);
    if (decision === "other" && !selectedJob) return;
    const question = decision === "jobA"
      ? `Move ${review.userBName}'s affected entries to ${review.jobAName}?`
      : decision === "jobB"
        ? `Move ${review.userAName}'s affected entries to ${review.jobBName}?`
        : decision === "other"
          ? `Move both affected sets of entries to ${selectedJob!.name}?`
          : `Confirm that ${review.userAName} and ${review.userBName} worked separate jobs? No hours will change.`;
    if (!window.confirm(question)) return;
    setMessage("");
    if (await act({ action: "resolveJobMismatch", reviewId: review.id, decision, jobId: selectedJobId })) {
      setMessage(decision === "separate" ? "Review closed. No hours were changed." : "The affected hours were moved and the review was closed.");
      await loadReviews();
    }
  };

  return <section>
    <div className="sectionHead"><div><span className="eyebrow">Administration</span><h2>Job reviews</h2><p className="sectionHint">HazenTime looks for coworkers with closely matching daily hours but different primary jobs. These are suggestions only—hours never move until you confirm the right job.</p></div></div>
    {message && <div className="successMessage jobReviewMessage">{message}</div>}
    {!result ? <div className="reportEmpty"><div className="spinner" /><p>Checking job entries…</p></div> :
      result.reviews.length === 0 ? <div className="reportEmpty"><span aria-hidden="true">✓</span><h3>No job mismatches need review</h3><p>New potential mismatches will appear here and send a push notification.</p></div> :
      <div className="jobReviewList">{result.reviews.map((review) => <article id={`job-review-${review.id}`} className={`jobReviewCard ${review.id === focusedId ? "requestFocused" : ""}`} key={review.id}>
        <header>
          <div><span className={`mismatchBadge ${review.confidence}`}>{review.confidence === "likely" ? "Likely mismatch" : "Possible mismatch"}</span><h3>{dateRangeLabel(review.startDate, review.endDate)}</h3><p>{review.dates.length} {review.dates.length === 1 ? "day" : "days"}: {review.dates.map((date) => dayLabel(date)).join(", ")}</p></div>
        </header>
        <div className="jobReviewCompare">
          <div><span>{review.userAName}</span><strong>{review.jobAName}</strong><small>{Number(review.hoursA).toFixed(2)} affected hours</small></div>
          <div className="jobReviewVersus" aria-hidden="true">or</div>
          <div><span>{review.userBName}</span><strong>{review.jobBName}</strong><small>{Number(review.hoursB).toFixed(2)} affected hours</small></div>
        </div>
        <p className="jobReviewReason">Their daily totals were close, and their prior entries indicate they usually worked together. Which job is correct?</p>
        <div className="jobDecisionGrid">
          <button className="primary" disabled={busy} onClick={() => void resolveReview(review, "jobA")}>Move {review.userBName} to {review.jobAName}</button>
          <button className="primary" disabled={busy} onClick={() => void resolveReview(review, "jobB")}>Move {review.userAName} to {review.jobBName}</button>
        </div>
        <div className="otherJobDecision">
          <label>Neither job is right<select value={otherJobs[review.id] || ""} onChange={(event) => setOtherJobs({ ...otherJobs, [review.id]: Number(event.target.value) })}><option value="">Choose the correct job…</option>{result.jobs.map((job) => <option key={job.id} value={job.id}>{job.name}{!job.active ? " (complete)" : ""}</option>)}</select></label>
          <button className="secondary" disabled={busy || !otherJobs[review.id]} onClick={() => void resolveReview(review, "other")}>Move both</button>
        </div>
        <button className="textButton separateJobs" disabled={busy} onClick={() => void resolveReview(review, "separate")}>No change — they worked separate jobs</button>
      </article>)}</div>}
  </section>;
}

function Jobs({ jobs, busy, act }: { jobs: Job[]; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [id, setId] = useState(0); const [name, setName] = useState("");
  const activeJobs = jobs.filter((job) => Boolean(job.active));
  const completedJobs = jobs.filter((job) => !job.active);
  return <section><div className="sectionHead"><div><span className="eyebrow">Administration</span><h2>Jobs</h2><p className="sectionHint">Complete a job to hide it from employees. Its existing hours and reports stay preserved, and administrators can still use it.</p></div></div><div className="management"><form className="editorCard" onSubmit={async (e) => { e.preventDefault(); if (await act({ action: "saveJob", id, name })) { setId(0); setName(""); } }}><h3>{id ? "Rename job" : "Add job"}</h3><label>Job name<input value={name} onChange={(e) => setName(e.target.value)} required /></label><button className="primary" disabled={busy}>Save job</button></form><div className="jobAdminLists"><div><span className="eyebrow">Available to employees</span><div className="itemList">{activeJobs.map((job) => <div className="listItem" key={job.id}><strong>{job.name}</strong><div><button className="secondary" onClick={() => { setId(job.id); setName(job.name); }}>Edit</button><button className="secondary completeButton" disabled={busy} onClick={() => { if (confirm(`Mark ${job.name} complete? Employees will no longer see it when entering time.`)) void act({ action: "completeJob", id: job.id }); }}>Complete</button><button className="danger" onClick={() => { if (confirm(`Remove ${job.name}? This only works if no hours have ever been logged to it.`)) void act({ action: "deleteJob", id: job.id }); }}>Remove</button></div></div>)}</div></div>{completedJobs.length > 0 && <div className="completedJobs"><div><span className="eyebrow">Preserved jobs</span><h3>Complete</h3></div><div className="itemList">{completedJobs.map((job) => <div className="listItem archivedItem" key={job.id}><div><strong>{job.name}</strong><span>Hidden from employees · Hours preserved</span></div><div><button className="secondary" disabled={busy} onClick={() => void act({ action: "reopenJob", id: job.id })}>Reopen</button><button className="secondary" onClick={() => { setId(job.id); setName(job.name); }}>Rename</button></div></div>)}</div></div>}</div></div></section>;
}

function AdminAccount({ name, busy, act }: { name: string; busy: boolean; act: (body: Record<string, unknown>, reload?: boolean) => Promise<boolean> }) {
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [message, setMessage] = useState("");
  const pinsMatch = newPin === confirmPin;

  return <section>
    <div className="sectionHead">
      <div><span className="eyebrow">Administration</span><h2>Admin account</h2><p className="sectionHint">Signed in as {name}. Change the administrator PIN here.</p></div>
    </div>
    <div className="management singlePanel">
      <form className="editorCard" onSubmit={async (event) => {
        event.preventDefault();
        setMessage("");
        if (!pinsMatch) return;
        if (await act({ action: "changeAdminPin", currentPin, newPin }, false)) {
          setCurrentPin("");
          setNewPin("");
          setConfirmPin("");
          setMessage("PIN changed successfully.");
        }
      }}>
        <h3>Change PIN</h3>
        <label>Current PIN<input value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" autoComplete="current-password" required /></label>
        <label>New 6-digit PIN<input value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" autoComplete="new-password" pattern="\d{6}" required /></label>
        <label>Confirm new PIN<input value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" autoComplete="new-password" pattern="\d{6}" required /></label>
        {confirmPin && !pinsMatch ? <div className="alert inlineAlert">The new PINs do not match.</div> : null}
        {message ? <div className="successMessage">{message}</div> : null}
        <button className="primary" disabled={busy || currentPin.length !== 6 || newPin.length !== 6 || !pinsMatch}>{busy ? "Changing…" : "Change PIN"}</button>
      </form>
    </div>
  </section>;
}
