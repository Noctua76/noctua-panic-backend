ALTER TABLE users
  ADD COLUMN IF NOT EXISTS temporary_access_activation_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temporary_access_expiry_reason VARCHAR(48),
  ADD COLUMN IF NOT EXISTS temporary_access_auto_expired_at TIMESTAMPTZ;

ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS temporary_access_activation_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temporary_access_expiry_reason VARCHAR(48),
  ADD COLUMN IF NOT EXISTS temporary_access_auto_expired_at TIMESTAMPTZ;

UPDATE users
SET temporary_access_activation_deadline = created_at + INTERVAL '14 days'
WHERE access_mode = 'read_only'
  AND temporary_access_group_id IS NOT NULL
  AND temporary_access_activation_deadline IS NULL;

UPDATE guards
SET temporary_access_activation_deadline = created_at + INTERVAL '14 days'
WHERE access_mode = 'read_only'
  AND temporary_access_group_id IS NOT NULL
  AND temporary_access_activation_deadline IS NULL;

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id BIGSERIAL PRIMARY KEY,
  surface VARCHAR(24) NOT NULL,
  username_normalized VARCHAR(160) NOT NULL,
  account_id BIGINT,
  source_ip VARCHAR(64) NOT NULL,
  succeeded BOOLEAN NOT NULL DEFAULT FALSE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_login_attempts_account_window_idx
  ON auth_login_attempts (surface, username_normalized, attempted_at DESC);

CREATE INDEX IF NOT EXISTS auth_login_attempts_ip_window_idx
  ON auth_login_attempts (source_ip, attempted_at DESC);

CREATE TABLE IF NOT EXISTS auth_throttle_state (
  scope_type VARCHAR(16) NOT NULL,
  scope_key VARCHAR(240) NOT NULL,
  blocked_until TIMESTAMPTZ NOT NULL,
  action VARCHAR(32) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS auth_throttle_state_blocked_until_idx
  ON auth_throttle_state (blocked_until);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  surface VARCHAR(24) NOT NULL,
  username_normalized VARCHAR(160),
  account_id BIGINT,
  source_ip VARCHAR(64) NOT NULL,
  failed_attempt_count INTEGER NOT NULL,
  distinct_username_count INTEGER,
  action VARCHAR(32) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_events_created_at_idx
  ON security_events (created_at DESC);

CREATE TABLE IF NOT EXISTS patrol_corrections (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  patrol_log_id BIGINT,
  occurrence_key VARCHAR(220) NOT NULL,
  schedule_id BIGINT,
  scheduled_at TIMESTAMP,
  field_name VARCHAR(64) NOT NULL,
  original_value TEXT,
  corrected_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  original_record JSONB NOT NULL,
  corrected_by INTEGER NOT NULL REFERENCES users(id),
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patrol_corrections_outcome_field_chk
    CHECK (field_name = 'outcome'),
  CONSTRAINT patrol_corrections_outcome_value_chk
    CHECK (corrected_value IN ('MISSED', 'COMPLETED', 'COMPLETED_LATE')),
  CONSTRAINT patrol_corrections_reason_length_chk
    CHECK (CHAR_LENGTH(BTRIM(reason)) BETWEEN 10 AND 1000)
);

CREATE INDEX IF NOT EXISTS patrol_corrections_occurrence_idx
  ON patrol_corrections (occurrence_key, corrected_at ASC);

CREATE INDEX IF NOT EXISTS patrol_corrections_site_time_idx
  ON patrol_corrections (site_id, corrected_at DESC);

CREATE OR REPLACE FUNCTION prevent_patrol_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Patrol operational history is immutable; create a patrol correction instead';
END;
$$;

DROP TRIGGER IF EXISTS patrol_logs_immutable_trigger ON patrol_logs;
CREATE TRIGGER patrol_logs_immutable_trigger
  BEFORE UPDATE OR DELETE ON patrol_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_patrol_history_mutation();

DROP TRIGGER IF EXISTS patrol_corrections_immutable_trigger ON patrol_corrections;
CREATE TRIGGER patrol_corrections_immutable_trigger
  BEFORE UPDATE OR DELETE ON patrol_corrections
  FOR EACH ROW
  EXECUTE FUNCTION prevent_patrol_history_mutation();
