const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyPatrolLifecycle,
  generateBalancedMinuteOffsets,
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

function expectedSegments(start, end, count) {
  const totalMinutes = end - start + 1;
  return Array.from({ length: count }, (_, index) => ({
    start: start + Math.floor((index * totalMinutes) / count),
    end: start + Math.floor(((index + 1) * totalMinutes) / count) - 1,
  }));
}

function assertMinimumSpacing(offsets) {
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] - offsets[index - 1] >= 30);
  }
}

test("full-day generation places one random patrol in each balanced segment", () => {
  const offsets = generateRandomMinuteOffsets(5, (max) => Math.floor(max / 2));
  const segments = expectedSegments(17, 1439, 5);

  assert.equal(offsets.length, 5);
  offsets.forEach((minute, index) => {
    assert.ok(minute >= segments[index].start);
    assert.ok(minute <= segments[index].end);
  });
  assertMinimumSpacing(offsets);
});

test("full-day generation supports 20 patrols with minimum 30-minute spacing", () => {
  const offsets = generateRandomMinuteOffsets(20, (max) => max - 1);
  assert.equal(offsets.length, 20);
  assertMinimumSpacing(offsets);
});

test("random patrol count accepts only 1 through 20", () => {
  assert.throws(() => generateRandomMinuteOffsets(0));
  assert.throws(() => generateRandomMinuteOffsets(21));
});

test("partial first day covers the entire remaining window with balanced segments", () => {
  const offsets = generatePartialDayMinuteOffsets({
    currentMinute: 12 * 60,
    currentSecond: 20,
    maxCount: 5,
    randomInt: (max) => Math.floor(max / 2),
  });
  const earliestMinute = (12 * 60) + 17;
  const segments = expectedSegments(earliestMinute, 1439, 5);

  assert.equal(offsets.length, 5);
  offsets.forEach((minute, index) => {
    assert.ok(minute >= segments[index].start);
    assert.ok(minute <= segments[index].end);
  });
  assertMinimumSpacing(offsets);
  assert.ok(offsets.at(-1) >= segments.at(-1).start);
});

test("partial first day caps count at feasible capacity and stays in bounds", () => {
  const currentMinute = 22 * 60;
  const earliestMinute = currentMinute + 16;
  const feasibleCount = Math.floor((1439 - earliestMinute) / 30) + 1;
  const offsets = generatePartialDayMinuteOffsets({
    currentMinute,
    maxCount: 20,
    randomInt: () => 0,
  });

  assert.equal(offsets.length, feasibleCount);
  assert.ok(offsets.every((minute) => minute >= earliestMinute && minute <= 1439));
  assertMinimumSpacing(offsets);
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
  const offsets = generateRandomMinuteOffsets(19, () => 0);
  assert.equal(offsets.length, 19);
});

test("balanced generation can produce different non-fixed exact times", () => {
  const early = generateBalancedMinuteOffsets({
    windowStartMinute: 17,
    windowEndMinute: 1439,
    count: 5,
    randomInt: () => 0,
  });
  const varied = generateBalancedMinuteOffsets({
    windowStartMinute: 17,
    windowEndMinute: 1439,
    count: 5,
    randomInt: (max) => Math.floor(max * 0.63),
  });

  assert.notDeepEqual(early, varied);
  const gaps = varied.slice(1).map((minute, index) => minute - varied[index]);
  assert.ok(new Set(gaps).size > 1);
  assertMinimumSpacing(varied);
});
