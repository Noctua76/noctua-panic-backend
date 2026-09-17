CREATE TABLE IF NOT EXISTS random_patrol_configurations (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  patrol_point_id INTEGER NOT NULL REFERENCES patrol_points(id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  patrols_per_day INTEGER NOT NULL,
  effective_from_date DATE NOT NULL,
  updated_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT random_patrol_config_count_chk
    CHECK (patrols_per_day BETWEEN 1 AND 20),
  CONSTRAINT random_patrol_config_scope_uniq
    UNIQUE (company_id, site_id, patrol_point_id)
);

CREATE INDEX IF NOT EXISTS random_patrol_config_generation_idx
  ON random_patrol_configurations (enabled, effective_from_date, company_id, site_id);

CREATE TABLE IF NOT EXISTS random_patrol_configuration_history (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  patrol_point_id INTEGER NOT NULL REFERENCES patrol_points(id),
  admin_user_id INTEGER NOT NULL REFERENCES users(id),
  previous_enabled BOOLEAN,
  new_enabled BOOLEAN NOT NULL,
  previous_patrols_per_day INTEGER,
  new_patrols_per_day INTEGER NOT NULL,
  effective_from_date DATE NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT random_patrol_history_count_chk
    CHECK (new_patrols_per_day BETWEEN 1 AND 20)
);

CREATE INDEX IF NOT EXISTS random_patrol_config_history_scope_idx
  ON random_patrol_configuration_history
    (company_id, site_id, patrol_point_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS random_patrol_days (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  patrol_point_id INTEGER NOT NULL REFERENCES patrol_points(id),
  local_date DATE NOT NULL,
  timezone VARCHAR(80) NOT NULL,
  configured_count INTEGER NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT random_patrol_day_count_chk
    CHECK (configured_count BETWEEN 1 AND 20),
  CONSTRAINT random_patrol_day_scope_uniq
    UNIQUE (company_id, site_id, patrol_point_id, local_date)
);

CREATE INDEX IF NOT EXISTS random_patrol_days_lookup_idx
  ON random_patrol_days (company_id, site_id, local_date, patrol_point_id);

CREATE TABLE IF NOT EXISTS random_patrol_occurrences (
  id BIGSERIAL PRIMARY KEY,
  random_patrol_day_id BIGINT NOT NULL REFERENCES random_patrol_days(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  patrol_point_id INTEGER NOT NULL REFERENCES patrol_points(id),
  sequence_number INTEGER NOT NULL,
  scheduled_at TIMESTAMP NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT random_patrol_occurrence_sequence_chk
    CHECK (sequence_number BETWEEN 1 AND 20),
  CONSTRAINT random_patrol_occurrence_sequence_uniq
    UNIQUE (random_patrol_day_id, sequence_number),
  CONSTRAINT random_patrol_occurrence_time_uniq
    UNIQUE (random_patrol_day_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS random_patrol_occurrence_board_idx
  ON random_patrol_occurrences (company_id, site_id, scheduled_at);

ALTER TABLE patrol_logs
  ADD COLUMN IF NOT EXISTS random_occurrence_id BIGINT
    REFERENCES random_patrol_occurrences(id);

CREATE UNIQUE INDEX IF NOT EXISTS patrol_logs_random_occurrence_unique_idx
  ON patrol_logs (random_occurrence_id)
  WHERE random_occurrence_id IS NOT NULL;

DROP TRIGGER IF EXISTS random_patrol_configuration_history_immutable_trigger
  ON random_patrol_configuration_history;
CREATE TRIGGER random_patrol_configuration_history_immutable_trigger
  BEFORE UPDATE OR DELETE ON random_patrol_configuration_history
  FOR EACH ROW EXECUTE FUNCTION prevent_patrol_history_mutation();

DROP TRIGGER IF EXISTS random_patrol_days_immutable_trigger ON random_patrol_days;
CREATE TRIGGER random_patrol_days_immutable_trigger
  BEFORE UPDATE OR DELETE ON random_patrol_days
  FOR EACH ROW EXECUTE FUNCTION prevent_patrol_history_mutation();

DROP TRIGGER IF EXISTS random_patrol_occurrences_immutable_trigger
  ON random_patrol_occurrences;
CREATE TRIGGER random_patrol_occurrences_immutable_trigger
  BEFORE UPDATE OR DELETE ON random_patrol_occurrences
  FOR EACH ROW EXECUTE FUNCTION prevent_patrol_history_mutation();
