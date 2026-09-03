BEGIN;

LOCK TABLE patrol_logs IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS patrol_logs_duplicate_archive (
  archive_id BIGSERIAL PRIMARY KEY,
  original_patrol_log_id BIGINT NOT NULL UNIQUE,
  patrol_log JSONB NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archive_reason TEXT NOT NULL
);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        schedule_id,
        COALESCE(schedule_type, 'recurring'),
        scheduled_at
      ORDER BY patrol_time ASC NULLS LAST, id ASC
    ) AS duplicate_rank
  FROM patrol_logs
  WHERE schedule_id IS NOT NULL
    AND scheduled_at IS NOT NULL
),
duplicates AS (
  SELECT id
  FROM ranked
  WHERE duplicate_rank > 1
)
INSERT INTO patrol_logs_duplicate_archive (
  original_patrol_log_id,
  patrol_log,
  archived_at,
  archive_reason
)
SELECT
  pl.id,
  TO_JSONB(pl),
  NOW(),
  'duplicate patrol occurrence removed before unique index'
FROM patrol_logs pl
INNER JOIN duplicates d
  ON d.id = pl.id
ON CONFLICT (original_patrol_log_id) DO NOTHING;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        schedule_id,
        COALESCE(schedule_type, 'recurring'),
        scheduled_at
      ORDER BY patrol_time ASC NULLS LAST, id ASC
    ) AS duplicate_rank
  FROM patrol_logs
  WHERE schedule_id IS NOT NULL
    AND scheduled_at IS NOT NULL
)
DELETE FROM patrol_logs pl
USING ranked
WHERE pl.id = ranked.id
  AND ranked.duplicate_rank > 1;

UPDATE patrol_logs
SET
  completion_status = CASE
    WHEN COALESCE(delay_minutes, 0) > 0
      THEN 'completed_late'
    ELSE 'completed'
  END,
  was_missed = false
WHERE was_missed IS TRUE
  OR completion_status = 'missed_completed_late';

CREATE UNIQUE INDEX IF NOT EXISTS
  patrol_logs_occurrence_unique_idx
ON patrol_logs (
  schedule_id,
  (COALESCE(schedule_type, 'recurring')),
  scheduled_at
)
WHERE schedule_id IS NOT NULL
  AND scheduled_at IS NOT NULL;

COMMIT;
