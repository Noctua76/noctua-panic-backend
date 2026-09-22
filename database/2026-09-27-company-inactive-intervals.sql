CREATE TABLE IF NOT EXISTS company_inactive_intervals (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  started_by INTEGER REFERENCES users(id),
  ended_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT company_inactive_interval_order_chk CHECK (
    ended_at IS NULL OR ended_at >= started_at
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS company_inactive_intervals_open_idx
  ON company_inactive_intervals(company_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS company_inactive_intervals_lookup_idx
  ON company_inactive_intervals(company_id, started_at, ended_at);

INSERT INTO company_inactive_intervals (
  company_id,
  started_at,
  ended_at,
  started_by,
  ended_by
)
SELECT
  inactive_event.company_id,
  inactive_event.changed_at,
  reactivation.changed_at,
  inactive_event.changed_by,
  reactivation.changed_by
FROM company_status_audit_events inactive_event
LEFT JOIN LATERAL (
  SELECT resumed.changed_at, resumed.changed_by
  FROM company_status_audit_events resumed
  WHERE resumed.company_id = inactive_event.company_id
    AND resumed.changed_at > inactive_event.changed_at
    AND resumed.previous_status = 'inactive'
    AND resumed.new_status IN ('active', 'pilot')
  ORDER BY resumed.changed_at ASC, resumed.id ASC
  LIMIT 1
) reactivation ON TRUE
WHERE inactive_event.new_status = 'inactive'
  AND NOT EXISTS (
    SELECT 1
    FROM company_inactive_intervals existing
    WHERE existing.company_id = inactive_event.company_id
      AND existing.started_at = inactive_event.changed_at
  );

INSERT INTO company_inactive_intervals (company_id, started_at, started_by)
SELECT
  c.id,
  COALESCE(last_inactive.changed_at, NOW()),
  last_inactive.changed_by
FROM companies c
LEFT JOIN LATERAL (
  SELECT csa.changed_at, csa.changed_by
  FROM company_status_audit_events csa
  WHERE csa.company_id = c.id
    AND csa.new_status = 'inactive'
  ORDER BY csa.changed_at DESC, csa.id DESC
  LIMIT 1
) last_inactive ON TRUE
WHERE c.status = 'inactive'
  AND NOT EXISTS (
    SELECT 1
    FROM company_inactive_intervals existing
    WHERE existing.company_id = c.id
      AND existing.ended_at IS NULL
  );

CREATE OR REPLACE FUNCTION is_company_operational_at(
  p_company_id INTEGER,
  p_local_timestamp TIMESTAMP,
  p_timezone TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM company_inactive_intervals inactive
    WHERE inactive.company_id = p_company_id
      AND p_local_timestamp >= (
        inactive.started_at AT TIME ZONE COALESCE(NULLIF(p_timezone, ''), 'Europe/Athens')
      )
      AND (
        inactive.ended_at IS NULL
        OR p_local_timestamp < (
          inactive.ended_at AT TIME ZONE COALESCE(NULLIF(p_timezone, ''), 'Europe/Athens')
        )
      )
  );
$$;
