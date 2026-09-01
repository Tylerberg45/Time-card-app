/**
 * @typedef {{
 *   id: number;
 *   userId: number;
 *   userName: string;
 *   jobId: number;
 *   jobName: string;
 *   workDate: string;
 *   hours: number;
 * }} MismatchEntry
 *
 * @typedef {{
 *   fingerprint: string;
 *   userAId: number;
 *   userAName: string;
 *   userBId: number;
 *   userBName: string;
 *   jobAId: number;
 *   jobAName: string;
 *   jobBId: number;
 *   jobBName: string;
 *   startDate: string;
 *   endDate: string;
 *   dates: string[];
 *   entryIdsA: number[];
 *   entryIdsB: number[];
 *   hoursA: number;
 *   hoursB: number;
 *   confidence: "possible" | "likely";
 * }} JobMismatch
 */

const DAY_MS = 86_400_000;

/** @param {string} left @param {string} right */
function daysBetween(left, right) {
  return Math.round((Date.parse(`${right}T12:00:00Z`) - Date.parse(`${left}T12:00:00Z`)) / DAY_MS);
}

/**
 * Looks for employees who historically work together, then finds dates where
 * their dominant job differs even though their daily totals are very close.
 * A low-dominance split-job day is intentionally ignored.
 *
 * @param {MismatchEntry[]} sourceRows
 * @returns {JobMismatch[]}
 */
export function detectJobMismatches(sourceRows) {
  const rows = sourceRows
    .map((row) => ({
      ...row,
      id: Number(row.id),
      userId: Number(row.userId),
      jobId: Number(row.jobId),
      hours: Number(row.hours),
    }))
    .filter((row) => row.id > 0 && row.userId > 0 && row.jobId > 0 && row.hours > 0 && /^\d{4}-\d{2}-\d{2}$/.test(row.workDate));

  /** @type {Map<string, Map<number, {userId:number; userName:string; total:number; jobs:Map<number, {jobId:number; jobName:string; hours:number; entryIds:number[]}>}>>} */
  const dates = new Map();
  for (const row of rows) {
    const users = dates.get(row.workDate) ?? new Map();
    const person = users.get(row.userId) ?? { userId: row.userId, userName: row.userName, total: 0, jobs: new Map() };
    const job = person.jobs.get(row.jobId) ?? { jobId: row.jobId, jobName: row.jobName, hours: 0, entryIds: [] };
    person.total += row.hours;
    job.hours += row.hours;
    job.entryIds.push(row.id);
    person.jobs.set(row.jobId, job);
    users.set(row.userId, person);
    dates.set(row.workDate, users);
  }

  /** @type {Map<string, {comparable:number; same:number; candidates:Array<{date:string; a:ReturnType<typeof summarizePerson>; b:ReturnType<typeof summarizePerson>}>}>} */
  const pairs = new Map();
  for (const [date, users] of [...dates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const people = [...users.values()].sort((left, right) => left.userId - right.userId).map(summarizePerson);
    for (let left = 0; left < people.length; left += 1) {
      for (let right = left + 1; right < people.length; right += 1) {
        const a = people[left];
        const b = people[right];
        if (!a.primary || !b.primary || a.dominance < 0.75 || b.dominance < 0.75) continue;
        const key = `${a.userId}:${b.userId}`;
        const pair = pairs.get(key) ?? { comparable: 0, same: 0, candidates: [] };
        pair.comparable += 1;
        if (a.primary.jobId === b.primary.jobId) {
          pair.same += 1;
        } else {
          const largestTotal = Math.max(a.total, b.total);
          const closeEnough = Math.abs(a.total - b.total) <= Math.max(2, largestTotal * 0.2);
          if (closeEnough) pair.candidates.push({ date, a, b });
        }
        pairs.set(key, pair);
      }
    }
  }

  /** @type {JobMismatch[]} */
  const reviews = [];
  for (const pair of pairs.values()) {
    // Three matching days plus a 60% matching history is enough evidence that
    // the pair normally works together, while still allowing genuine splits.
    if (pair.comparable < 4 || pair.same < 3 || pair.same / pair.comparable < 0.6) continue;
    const byJobs = new Map();
    for (const candidate of pair.candidates) {
      const key = `${candidate.a.primary.jobId}:${candidate.b.primary.jobId}`;
      const values = byJobs.get(key) ?? [];
      values.push(candidate);
      byJobs.set(key, values);
    }
    for (const values of byJobs.values()) {
      values.sort((left, right) => left.date.localeCompare(right.date));
      /** @type {typeof values} */
      let run = [];
      const finishRun = () => {
        if (!run.length) return;
        const first = run[0];
        const last = run[run.length - 1];
        const reviewDates = run.map((item) => item.date);
        reviews.push({
          fingerprint: `${first.a.userId}:${first.b.userId}:${first.a.primary.jobId}:${first.b.primary.jobId}:${reviewDates.join(",")}`,
          userAId: first.a.userId,
          userAName: first.a.userName,
          userBId: first.b.userId,
          userBName: first.b.userName,
          jobAId: first.a.primary.jobId,
          jobAName: first.a.primary.jobName,
          jobBId: first.b.primary.jobId,
          jobBName: first.b.primary.jobName,
          startDate: first.date,
          endDate: last.date,
          dates: reviewDates,
          entryIdsA: run.flatMap((item) => item.a.primary.entryIds),
          entryIdsB: run.flatMap((item) => item.b.primary.entryIds),
          hoursA: run.reduce((sum, item) => sum + item.a.primary.hours, 0),
          hoursB: run.reduce((sum, item) => sum + item.b.primary.hours, 0),
          confidence: run.length > 1 ? "likely" : "possible",
        });
        run = [];
      };
      for (const candidate of values) {
        if (run.length && daysBetween(run[run.length - 1].date, candidate.date) > 3) finishRun();
        run.push(candidate);
      }
      finishRun();
    }
  }
  return reviews.sort((left, right) => right.startDate.localeCompare(left.startDate));
}

/** @param {{userId:number; userName:string; total:number; jobs:Map<number, {jobId:number; jobName:string; hours:number; entryIds:number[]}>}} person */
function summarizePerson(person) {
  const primary = [...person.jobs.values()].sort((left, right) => right.hours - left.hours || left.jobId - right.jobId)[0];
  return {
    ...person,
    primary,
    dominance: primary && person.total > 0 ? primary.hours / person.total : 0,
  };
}
