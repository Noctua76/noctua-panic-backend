const INCIDENT_RESOLVED_RECENT_HOURS = 2;
const INCIDENT_RESOLVED_RECENT_MS =
  INCIDENT_RESOLVED_RECENT_HOURS * 60 * 60 * 1000;

function isResolvedIncidentRecent(resolvedTime, now = Date.now()) {
  const resolvedAt = new Date(resolvedTime).getTime();
  const currentTime = new Date(now).getTime();

  if (!Number.isFinite(resolvedAt) || !Number.isFinite(currentTime)) {
    return false;
  }

  const elapsed = currentTime - resolvedAt;
  return elapsed >= 0 && elapsed < INCIDENT_RESOLVED_RECENT_MS;
}

module.exports = {
  INCIDENT_RESOLVED_RECENT_HOURS,
  INCIDENT_RESOLVED_RECENT_MS,
  isResolvedIncidentRecent,
};
