const PATROL_MISSED_STATS_SQL = `
  WITH runtime AS (
    SELECT COALESCE($2::timestamptz, NOW()) AS utc_now
  ),
  recurring_missed AS (
    SELECT
      slots.expected_at AS scheduled_at,
      COALESCE(c.timezone, 'Europe/Athens') AS timezone
    FROM patrol_schedules ps
    JOIN sites s ON s.id = ps.site_id
    JOIN companies c ON c.id = s.company_id
    CROSS JOIN runtime
    CROSS JOIN LATERAL (
      SELECT
        ((ps.created_at AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
          + ps.start_time) AS anchor_at,
        (runtime.utc_now AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')) AS local_now
    ) clock
    CROSS JOIN LATERAL generate_series(
      clock.anchor_at,
      clock.local_now,
      (ps.interval_hours || ' hours')::interval
    ) slots(expected_at)
    WHERE s.company_id = $1
      AND ps.schedule_type = 'recurring'
      AND ps.active = TRUE
      AND ps.start_time IS NOT NULL
      AND ps.interval_hours > 0
      AND slots.expected_at >= clock.local_now - INTERVAL '30 days'
      AND slots.expected_at + INTERVAL '2 hours' <= clock.local_now
      AND is_company_operational_at(
        s.company_id,
        slots.expected_at,
        COALESCE(c.timezone, 'Europe/Athens')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM patrol_logs pl
        WHERE pl.schedule_id = ps.id
          AND COALESCE(pl.schedule_type, 'recurring') = 'recurring'
          AND pl.scheduled_at = slots.expected_at
      )
  ),
  manual_missed AS (
    SELECT
      (ps.scheduled_date + ps.scheduled_time) AS scheduled_at,
      COALESCE(c.timezone, 'Europe/Athens') AS timezone
    FROM patrol_schedules ps
    JOIN sites s ON s.id = ps.site_id
    JOIN companies c ON c.id = s.company_id
    CROSS JOIN runtime
    WHERE s.company_id = $1
      AND ps.schedule_type = 'manual'
      AND ps.scheduled_date + ps.scheduled_time
        >= (runtime.utc_now AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')) - INTERVAL '30 days'
      AND ps.scheduled_date + ps.scheduled_time + INTERVAL '2 hours'
        <= (runtime.utc_now AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))
      AND is_company_operational_at(
        s.company_id,
        ps.scheduled_date + ps.scheduled_time,
        COALESCE(c.timezone, 'Europe/Athens')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM patrol_logs pl
        WHERE pl.schedule_id = ps.id
          AND COALESCE(pl.schedule_type, 'manual') = 'manual'
      )
  ),
  random_missed AS (
    SELECT
      rpo.scheduled_at,
      COALESCE(rpd.timezone, 'Europe/Athens') AS timezone
    FROM random_patrol_occurrences rpo
    JOIN random_patrol_days rpd
      ON rpd.id = rpo.random_patrol_day_id
     AND rpd.company_id = rpo.company_id
     AND rpd.site_id = rpo.site_id
    JOIN sites s
      ON s.id = rpo.site_id
     AND s.company_id = rpo.company_id
    CROSS JOIN runtime
    WHERE rpo.company_id = $1
      AND rpo.scheduled_at
        >= (runtime.utc_now AT TIME ZONE COALESCE(rpd.timezone, 'Europe/Athens')) - INTERVAL '30 days'
      AND rpo.scheduled_at + INTERVAL '2 hours'
        <= (runtime.utc_now AT TIME ZONE COALESCE(rpd.timezone, 'Europe/Athens'))
      AND is_company_operational_at(
        rpo.company_id,
        rpo.scheduled_at,
        COALESCE(rpd.timezone, 'Europe/Athens')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM patrol_logs pl
        WHERE pl.random_occurrence_id = rpo.id
      )
  )
  SELECT
    MAX(scheduled_at AT TIME ZONE timezone) AS last_missed_at,
    COUNT(*)::int AS missed_last_30_days
  FROM (
    SELECT scheduled_at, timezone FROM recurring_missed
    UNION ALL
    SELECT scheduled_at, timezone FROM manual_missed
    UNION ALL
    SELECT scheduled_at, timezone FROM random_missed
  ) missed
`;

module.exports = { PATROL_MISSED_STATS_SQL };
