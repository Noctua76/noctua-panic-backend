const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyPatrolLifecycle,
  generateRandomMinuteOffsets,
} = require("../patrol/lifecycle");

const scheduledAt = "2026-09-17T12:00:00.000Z";

test("patrol lifecycle enforces reveal, scan and missed boundaries", () => {
  assert.equal(classifyPatrolLifecycle({ scheduledAt, now: "2026-09-17T11:54:59.999Z" }).scanEnabled, false);
  assert.equal(classifyPatrolLifecycle({ scheduledAt, now: "2026-09-17T11:55:00.000Z" }).scanEnabled, true);
  assert.equal(classifyPatrolLifecycle({ scheduledAt, now: "2026-09-17T13:59:59.999Z" }).scanEnabled, true);
  const missed = classifyPatrolLifecycle({ scheduledAt, now: "2026-09-17T14:00:00.000Z" });
  assert.equal(missed.status, "missed");
  assert.equal(missed.scanEnabled, false);
});

test("completion at plus 15 minutes is completed", () => {
  const result = classifyPatrolLifecycle({
    scheduledAt,
    completedAt: "2026-09-17T12:15:00.000Z",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.delayMinutes, 15);
});

test("completion after plus 15 and before plus 2 hours is late completed", () => {
  const result = classifyPatrolLifecycle({
    scheduledAt,
    completedAt: "2026-09-17T12:15:00.001Z",
  });
  assert.equal(result.status, "completed_late");
});

test("random daily times are unique, sorted and at least 30 minutes apart", () => {
  let next = 0;
  const draws = [0, 1, 29, 30, 60, 120, 240, 360, 480, 600, 720, 840];
  const offsets = generateRandomMinuteOffsets(8, () => draws[next++]);
  assert.equal(offsets.length, 8);
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] - offsets[index - 1] >= 30);
  }
});

test("random patrol count accepts only 1 through 20", () => {
  assert.throws(() => generateRandomMinuteOffsets(0));
  assert.throws(() => generateRandomMinuteOffsets(21));
});
