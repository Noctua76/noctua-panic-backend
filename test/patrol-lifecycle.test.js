const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyPatrolLifecycle,
  generateRandomMinuteOffsets,
  generatePartialDayMinuteOffsets,
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

test("partial first day creates only future, reveal-safe, spaced occurrences", () => {
  let call = 0;
  const offsets = generatePartialDayMinuteOffsets({
    currentMinute: 18 * 60,
    currentSecond: 20,
    maxCount: 19,
    randomInt: () => (call++ === 0 ? 0 : 15),
  });

  assert.ok(offsets.length > 0);
  assert.ok(offsets.length < 19);
  assert.ok(offsets[0] >= (18 * 60) + 17);
  assert.ok(offsets.every((minute) => minute <= 1439));
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] - offsets[index - 1] >= 30);
  }
});

test("late-day activation may create an empty but valid partial schedule", () => {
  const offsets = generatePartialDayMinuteOffsets({
    currentMinute: 23 * 60 + 50,
    currentSecond: 0,
    maxCount: 20,
    randomInt: () => 0,
  });
  assert.deepEqual(offsets, []);
});

test("next full day still generates the exact configured count", () => {
  let value = 0;
  const offsets = generateRandomMinuteOffsets(19, () => {
    const result = value;
    value += 30;
    return result;
  });
  assert.equal(offsets.length, 19);
});
