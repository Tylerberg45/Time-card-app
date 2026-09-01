import assert from "node:assert/strict";
import test from "node:test";

import { detectJobMismatches } from "../app/job-mismatch-logic.mjs";

const entry = (id, userId, userName, jobId, jobName, workDate, hours) => ({
  id, userId, userName, jobId, jobName, workDate, hours,
});

test("finds the existing Kaufman Barn and Blanchard Road mismatch", () => {
  const rows = [
    // The real July 27–28 pattern. Tyler also had two legitimate Sivey hours.
    entry(5, 2, "Tyler Berg", 4, "Kaufman Barn", "2026-07-27", 8.25),
    entry(6, 2, "Tyler Berg", 5, "Sivey", "2026-07-27", 2),
    entry(8, 3, "Jayden Johnson", 6, "Blanchard rd barn", "2026-07-27", 10.25),
    entry(7, 2, "Tyler Berg", 4, "Kaufman Barn", "2026-07-28", 9.75),
    entry(9, 3, "Jayden Johnson", 6, "Blanchard rd barn", "2026-07-28", 9.75),

    // Their surrounding history establishes that they normally work together.
    entry(20, 2, "Tyler Berg", 6, "Blanchard rd barn", "2026-08-12", 9),
    entry(21, 3, "Jayden Johnson", 6, "Blanchard rd barn", "2026-08-12", 9),
    entry(22, 2, "Tyler Berg", 6, "Blanchard rd barn", "2026-08-13", 8.5),
    entry(23, 3, "Jayden Johnson", 6, "Blanchard rd barn", "2026-08-13", 8.5),
    entry(24, 2, "Tyler Berg", 6, "Blanchard rd barn", "2026-08-17", 10),
    entry(25, 3, "Jayden Johnson", 6, "Blanchard rd barn", "2026-08-17", 10),
    entry(26, 2, "Tyler Berg", 6, "Blanchard rd barn", "2026-08-18", 9.5),
    entry(27, 3, "Jayden Johnson", 6, "Blanchard rd barn", "2026-08-18", 9.5),

    // A normal split-job day must not become a mismatch review.
    entry(30, 2, "Tyler Berg", 6, "Blanchard rd barn", "2026-08-25", 8),
    entry(31, 2, "Tyler Berg", 7, "Apple", "2026-08-25", 3),
    entry(32, 3, "Jayden Johnson", 6, "Blanchard rd barn", "2026-08-25", 11.5),
  ];

  const reviews = detectJobMismatches(rows);
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0], {
    fingerprint: "2:3:4:6:2026-07-27,2026-07-28",
    userAId: 2,
    userAName: "Tyler Berg",
    userBId: 3,
    userBName: "Jayden Johnson",
    jobAId: 4,
    jobAName: "Kaufman Barn",
    jobBId: 6,
    jobBName: "Blanchard rd barn",
    startDate: "2026-07-27",
    endDate: "2026-07-28",
    dates: ["2026-07-27", "2026-07-28"],
    entryIdsA: [5, 7],
    entryIdsB: [8, 9],
    hoursA: 18,
    hoursB: 20,
    confidence: "likely",
  });
});

test("does not guess when employees have too little shared history", () => {
  const reviews = detectJobMismatches([
    entry(1, 2, "Tyler", 4, "Kaufman", "2026-08-30", 8),
    entry(2, 3, "Jayden", 6, "Blanchard", "2026-08-30", 8),
  ]);
  assert.deepEqual(reviews, []);
});
