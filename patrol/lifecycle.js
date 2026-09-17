const PATROL_TIMING = Object.freeze({
  revealMinutesBefore: 15,
  scanOpenMinutesBefore: 5,
  completedGraceMinutes: 15,
  missedAfterMinutes: 120,
});

function minutesBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / 60000);
}

function classifyPatrolLifecycle({ scheduledAt, completedAt = null, now = new Date() }) {
  const scheduled = new Date(scheduledAt);
  const current = new Date(now);
  const completion = completedAt ? new Date(completedAt) : null;
  const revealAt = new Date(scheduled.getTime() - PATROL_TIMING.revealMinutesBefore * 60000);
  const scanOpensAt = new Date(scheduled.getTime() - PATROL_TIMING.scanOpenMinutesBefore * 60000);
  const completedUntil = new Date(scheduled.getTime() + PATROL_TIMING.completedGraceMinutes * 60000);
  const missedAt = new Date(scheduled.getTime() + PATROL_TIMING.missedAfterMinutes * 60000);

  if (completion) {
    const status = completion <= completedUntil ? "completed" : "completed_late";
    return {
      status,
      boardGroup: status,
      scanEnabled: false,
      delayMinutes: Math.max(0, minutesBetween(completion, scheduled)),
      revealAt,
      scanOpensAt,
      completedUntil,
      missedAt,
    };
  }

  let status = "scheduled";
  let boardGroup = "upcoming";
  if (current >= missedAt) {
    status = "missed";
    boardGroup = "missed";
  } else if (current >= scheduled) {
    status = "overdue";
    boardGroup = "active";
  } else if (current >= scanOpensAt) {
    status = "due_soon";
    boardGroup = "active";
  }

  return {
    status,
    boardGroup,
    scanEnabled: current >= scanOpensAt && current < missedAt,
    delayMinutes: Math.max(0, minutesBetween(current, scheduled)),
    revealAt,
    scanOpensAt,
    completedUntil,
    missedAt,
  };
}

const RANDOM_PATROL_MINIMUM_SPACING_MINUTES = 30;

function generateBalancedMinuteOffsets({
  windowStartMinute,
  windowEndMinute,
  count,
  randomInt,
}) {
  if (!Number.isInteger(windowStartMinute) || !Number.isInteger(windowEndMinute)) {
    throw new Error("Random patrol window boundaries must be whole minutes");
  }
  if (windowStartMinute < 0 || windowEndMinute > 1439 || windowStartMinute > windowEndMinute) {
    return [];
  }
  if (!Number.isInteger(count) || count < 1) return [];

  const feasibleCount = Math.floor(
    (windowEndMinute - windowStartMinute) / RANDOM_PATROL_MINIMUM_SPACING_MINUTES
  ) + 1;
  const generatedCount = Math.min(count, feasibleCount);
  const totalMinutes = windowEndMinute - windowStartMinute + 1;
  const segments = Array.from({ length: generatedCount }, (_, index) => ({
    start: windowStartMinute + Math.floor((index * totalMinutes) / generatedCount),
    end: windowStartMinute
      + Math.floor(((index + 1) * totalMinutes) / generatedCount)
      - 1,
  }));

  // Work backwards to cap each draw at a minute that still leaves a valid
  // >=30-minute choice inside every later segment.
  const latest = new Array(generatedCount);
  latest[generatedCount - 1] = segments[generatedCount - 1].end;
  for (let index = generatedCount - 2; index >= 0; index -= 1) {
    latest[index] = Math.min(
      segments[index].end,
      latest[index + 1] - RANDOM_PATROL_MINIMUM_SPACING_MINUTES
    );
  }

  const draw = randomInt || ((max) => require("crypto").randomInt(max));
  const selected = [];
  for (let index = 0; index < generatedCount; index += 1) {
    const earliest = Math.max(
      segments[index].start,
      index === 0
        ? windowStartMinute
        : selected[index - 1] + RANDOM_PATROL_MINIMUM_SPACING_MINUTES
    );
    const latestAllowed = latest[index];
    if (earliest > latestAllowed) {
      throw new Error("Unable to generate balanced random patrol times with 30-minute spacing");
    }
    selected.push(earliest + draw(latestAllowed - earliest + 1));
  }

  return selected;
}

function generateRandomMinuteOffsets(count, randomInt) {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Random patrol count must be an integer between 1 and 20");
  }
  return generateBalancedMinuteOffsets({
    // Full-day generation runs at 00:01. Minute 17 preserves the existing
    // reveal/notification safety buffer for the first possible occurrence.
    windowStartMinute: 17,
    windowEndMinute: 1439,
    count,
    randomInt,
  });
}

function generatePartialDayMinuteOffsets({
  currentMinute,
  currentSecond = 0,
  maxCount,
  randomInt,
}) {
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 20) {
    throw new Error("Random patrol count must be an integer between 1 and 20");
  }
  if (!Number.isInteger(currentMinute) || currentMinute < 0 || currentMinute > 1439) {
    throw new Error("currentMinute must be between 0 and 1439");
  }

  const roundedCurrentMinute = currentMinute + (Number(currentSecond) > 0 ? 1 : 0);
  const earliestMinute =
    roundedCurrentMinute + PATROL_TIMING.revealMinutesBefore + 1;
  return generateBalancedMinuteOffsets({
    windowStartMinute: earliestMinute,
    windowEndMinute: 1439,
    count: maxCount,
    randomInt,
  });
}

module.exports = {
  PATROL_TIMING,
  RANDOM_PATROL_MINIMUM_SPACING_MINUTES,
  classifyPatrolLifecycle,
  generateBalancedMinuteOffsets,
  generateRandomMinuteOffsets,
  generatePartialDayMinuteOffsets,
};
