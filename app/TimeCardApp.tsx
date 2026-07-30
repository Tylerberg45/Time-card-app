"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Person = { id: number; name: string; phone?: string; hourlyRate?: number };
type Job = { id: number; name: string };
type Entry = { id: number; userId: number; jobId: number; workDate: string; hours: number; note: string; flagged: number; flagReason: string; resolution: string; resolved: number };
type Data = {
  configured: boolean; authenticated?: boolean;
  admins?: Person[]; employees?: Person[]; user?: Person & { role: "admin" | "employee" };
  weekStart?: string; weekEnd?: string; jobs?: Job[]; target?: Person | null; entries?: Entry[]; paid?: boolean;
};

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

export default function TimeCardApp() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedLogin, setSelectedLogin] = useState<{ id: number; name: string; kind: string } | null>(null);
  const [week, setWeek] = useState("");
  const [employeeId, setEmployeeId] = useState(0);
  const [tab, setTab] = useState<"time" | "people" | "jobs">("time");

  const load = useCallback(async (nextWeek?: string, nextEmployee?: number) => {
    try {
      setError("");
      const w = nextWeek ?? week;
      const e = nextEmployee ?? employeeId;
      const result = await api(undefined, `${w ? `?week=${w}` : ""}${e ? `${w ? "&" : "?"}employeeId=${e}` : ""}`);
      setData(result);
      if (result.weekStart) setWeek(result.weekStart);
      if (result.target?.id) setEmployeeId(result.target.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load."); }
  }, [week, employeeId]);

  useEffect(() => {
    let active = true;
    api().then((result) => {
      if (!active) return;
      setData(result);
      if (result.weekStart) setWeek(result.weekStart);
      if (result.target?.id) setEmployeeId(result.target.id);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load.");
    });
    return () => { active = false; };
  }, []);

  const act = async (body: Record<string, unknown>, reload = true) => {
    setBusy(true); setError("");
    try { await api(body); if (reload) await load(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save."); return false; }
    finally { setBusy(false); }
  };

  if (!data) return <main className="center"><div className="spinner" /><p>Loading time cards…</p></main>;
  if (!data.configured) return <Setup busy={busy} error={error} onSubmit={async (name, pin) => { if (await act({ action: "setup", name, pin }, false)) await load(); }} />;
  if (!data.user) return <Login data={data} selected={selectedLogin} setSelected={setSelectedLogin} busy={busy} error={error} onLogin={async (pin) => { if (!selectedLogin) return; if (await act({ action: "login", userId: selectedLogin.id, pin }, false)) await load(); }} />;

  const isAdmin = data.user.role === "admin";
  const entries = data.entries ?? [];
  const totalHours = entries.reduce((sum, item) => sum + Number(item.hours), 0);
  const totalPay = totalHours * Number(data.target?.hourlyRate ?? 0);
  const changeWeek = (days: number) => void load(addDays(week, days), employeeId);
  const changeEmployee = (id: number) => { setEmployeeId(id); void load(week, id); };

  return (
    <main className="appShell">
      <header className="topbar">
        <div><span className="eyebrow">Hazen Construction</span><h1>Time Card</h1></div>
        <button className="textButton" onClick={async () => { await act({ action: "logout" }, false); setSelectedLogin(null); await load(); }}>Sign out</button>
      </header>
      {isAdmin && <nav className="tabs">
        <button className={tab === "time" ? "active" : ""} onClick={() => setTab("time")}>Time cards</button>
        <button className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>Employees</button>
        <button className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>Jobs</button>
      </nav>}
      {error && <div className="alert">{error}</div>}

      {tab === "people" && isAdmin ? <People people={data.employees ?? []} busy={busy} act={act} /> :
       tab === "jobs" && isAdmin ? <Jobs jobs={data.jobs ?? []} busy={busy} act={act} /> :
       <section>
        <div className="controls">
          {isAdmin && <label>Employee<select value={employeeId} onChange={(event) => changeEmployee(Number(event.target.value))}>
            {(data.employees ?? []).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label>}
          <div className="weekPicker"><button onClick={() => changeWeek(-7)} aria-label="Previous week">‹</button><strong>{dayLabel(week)} – {dayLabel(data.weekEnd!)}</strong><button onClick={() => changeWeek(7)} aria-label="Next week">›</button></div>
        </div>
        {data.target ? <>
          <div className="summary">
            <div><span>Employee</span><strong>{data.target.name}</strong></div>
            <div><span>Total hours</span><strong>{totalHours.toFixed(2)}</strong></div>
            {isAdmin && <><div><span>Rate</span><strong>{money(Number(data.target.hourlyRate ?? 0))}/hr</strong></div><div className="payTotal"><span>Check amount</span><strong>{money(totalPay)}</strong></div></>}
            <label className="paidCheck"><input type="checkbox" checked={Boolean(data.paid)} disabled={busy} onChange={(event) => void act({ action: "setPaid", userId: data.target!.id, weekStart: week, paid: event.target.checked })} /> Paid</label>
          </div>
          <TimeGrid week={week} jobs={data.jobs ?? []} entries={entries} targetId={data.target.id} isAdmin={isAdmin} busy={busy} act={act} />
        </> : <div className="empty"><h2>No employees yet</h2><p>Add an employee to start a time card.</p></div>}
      </section>}
    </main>
  );
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

function TimeGrid({ week, jobs, entries, targetId, isAdmin, busy, act }: { week: string; jobs: Job[]; entries: Entry[]; targetId: number; isAdmin: boolean; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [open, setOpen] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  return <div className="dayList">{days.map((date) => {
    const dayEntries = entries.filter((entry) => entry.workDate === date);
    const dayHours = dayEntries.reduce((sum, entry) => sum + Number(entry.hours), 0);
    return <article className="dayCard" key={date}><button className="dayHead" onClick={() => setOpen(open === date ? null : date)}><div><strong>{dayLabel(date)}</strong><span>{dayEntries.length ? `${dayEntries.length} job${dayEntries.length === 1 ? "" : "s"}` : "No time entered"}</span></div><b>{dayHours.toFixed(2)} hrs</b></button>{(open === date || dayEntries.length > 0) && <div className="dayBody">{jobs.map((job) => { const entry = dayEntries.find((item) => item.jobId === job.id); return <EntryRow key={`${job.id}-${JSON.stringify(entry)}`} date={date} job={job} entry={entry} targetId={targetId} isAdmin={isAdmin} busy={busy} act={act} />; })}</div>}</article>;
  })}</div>;
}

function EntryRow({ date, job, entry, targetId, isAdmin, busy, act }: { date: string; job: Job; entry?: Entry; targetId: number; isAdmin: boolean; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [hours, setHours] = useState(entry?.hours ? String(entry.hours) : "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [flagged, setFlagged] = useState(Boolean(entry?.flagged));
  const [flagReason, setFlagReason] = useState(entry?.flagReason ?? "");
  const [resolution, setResolution] = useState(entry?.resolution ?? "");
  const [resolved, setResolved] = useState(Boolean(entry?.resolved));
  const hasContent = Boolean(hours || note.trim() || flagged);
  const canSave = hasContent || Boolean(entry);
  return <div className={`entryRow ${flagged ? "isFlagged" : ""}`}><div className="entryMain"><strong>{job.name}</strong><label className="hoursField"><span>Hours</span><input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" type="number" min="0" max="24" step=".25" placeholder="0" /></label></div><label>Note<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional work note" rows={2} /></label><label className="flagCheck"><input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Flag this entry</label>{flagged && <label>Why is it flagged?<textarea value={flagReason} onChange={(e) => setFlagReason(e.target.value)} placeholder="Explain what needs attention" rows={2} /></label>}{isAdmin && entry?.flagged ? <div className="resolution"><label>Resolution comment<textarea value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="What was decided?" rows={2} /></label><label className="flagCheck"><input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /> Resolved</label><button className="secondary" disabled={busy} onClick={() => void act({ action: "resolve", entryId: entry.id, resolution, resolved })}>Save resolution</button></div> : null}{canSave && <button className="secondary saveEntry" disabled={busy || (flagged && !flagReason.trim())} onClick={() => void act({ action: "saveEntry", userId: targetId, jobId: job.id, workDate: date, hours: Number(hours) || 0, note, flagged, flagReason })}>{hasContent ? `Save ${job.name}` : `Remove ${job.name} time`}</button>}</div>;
}

function People({ people, busy, act }: { people: Person[]; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const blank = { id: 0, name: "", phone: "", hourlyRate: "", pin: "" };
  const [editing, setEditing] = useState(blank);
  return <section><div className="sectionHead"><div><span className="eyebrow">Administration</span><h2>Employees</h2><p className="sectionHint">Employees sign in from the main login screen. Sign out of the admin account, tap their name, then enter the PIN you created for them.</p></div><button className="primary compact" onClick={() => setEditing(blank)}>Add employee</button></div><div className="management"><form className="editorCard" onSubmit={async (e) => { e.preventDefault(); if (await act({ action: "saveEmployee", ...editing, hourlyRate: Number(editing.hourlyRate) || 0 })) setEditing(blank); }}><h3>{editing.id ? "Edit employee" : "New employee"}</h3><label>Name<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required /></label><label>Phone<input value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} inputMode="tel" /></label><label>Hourly pay<span className="currencyField"><span aria-hidden="true">$</span><input aria-label="Hourly pay in dollars" value={editing.hourlyRate} onChange={(e) => setEditing({ ...editing, hourlyRate: e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1") })} onBlur={() => editing.hourlyRate && setEditing({ ...editing, hourlyRate: Number(editing.hourlyRate).toFixed(2) })} inputMode="decimal" placeholder="0.00" /></span></label><label>{editing.id ? "New PIN (leave blank to keep)" : "PIN"}<input value={editing.pin} onChange={(e) => setEditing({ ...editing, pin: e.target.value.replace(/\D/g, "").slice(0, 6) })} inputMode="numeric" type="password" required={!editing.id} /></label><button className="primary" disabled={busy}>Save employee</button></form><div className="itemList">{people.map((person) => <div className="listItem" key={person.id}><div><strong>{person.name}</strong><span>{person.phone || "No phone"} · {money(Number(person.hourlyRate ?? 0))}/hr</span></div><div><button className="secondary" onClick={() => setEditing({ ...blank, ...person, hourlyRate: Number(person.hourlyRate ?? 0).toFixed(2) })}>Edit</button><button className="danger" onClick={() => { if (confirm(`Permanently remove ${person.name} and all of their time cards?`)) void act({ action: "deleteEmployee", id: person.id }); }}>Remove</button></div></div>)}</div></div></section>;
}

function Jobs({ jobs, busy, act }: { jobs: Job[]; busy: boolean; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [id, setId] = useState(0); const [name, setName] = useState("");
  return <section><div className="sectionHead"><div><span className="eyebrow">Administration</span><h2>Jobs</h2></div></div><div className="management"><form className="editorCard" onSubmit={async (e) => { e.preventDefault(); if (await act({ action: "saveJob", id, name })) { setId(0); setName(""); } }}><h3>{id ? "Rename job" : "Add job"}</h3><label>Job name<input value={name} onChange={(e) => setName(e.target.value)} required /></label><button className="primary" disabled={busy}>Save job</button></form><div className="itemList">{jobs.map((job) => <div className="listItem" key={job.id}><strong>{job.name}</strong><div><button className="secondary" onClick={() => { setId(job.id); setName(job.name); }}>Edit</button><button className="danger" onClick={() => { if (confirm(`Remove ${job.name}?`)) void act({ action: "deleteJob", id: job.id }); }}>Remove</button></div></div>)}</div></div></section>;
}
