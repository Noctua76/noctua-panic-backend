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

function generateRandomMinuteOffsets(count, randomInt) {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Random patrol count must be an integer between 1 and 20");
  }
  const draw = randomInt || ((max) => require("crypto").randomInt(max));
  const selected = [];
  let attempts = 0;
  while (selected.length < count && attempts < 20000) {
    attempts += 1;
    const minute = 17 + draw(1423);
    if (selected.every((existing) => Math.abs(existing - minute) >= 30)) {
      selected.push(minute);
    }
  }
  if (selected.length !== count) {
    throw new Error("Unable to generate random patrol times with 30-minute spacing");
  }
  return selected.sort((a, b) => a - b);
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

  const draw = randomInt || ((max) => require("crypto").randomInt(max));
  const roundedCurrentMinute = currentMinute + (Number(currentSecond) > 0 ? 1 : 0);
  const earliestMinute =
    roundedCurrentMinute + PATROL_TIMING.revealMinutesBefore + 1;
  const selected = [];

  if (earliestMinute > 1439) return selected;

  let minute = earliestMinute + draw(Math.min(31, 1440 - earliestMinute));
  while (minute <= 1439 && selected.length < maxCount) {
    selected.push(minute);
    minute += 30 + draw(31);
  }

  return selected;
}

module.exports = {
  PATROL_TIMING,
  classifyPatrolLifecycle,
  generateRandomMinuteOffsets,
  generatePartialDayMinuteOffsets,
};
