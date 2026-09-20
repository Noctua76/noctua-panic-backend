CREATE TABLE IF NOT EXISTS guard_shift_reports (
  id BIGSERIAL PRIMARY KEY,
  report_number VARCHAR(40) NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  guard_id INTEGER NOT NULL REFERENCES guards(id),
  session_id INTEGER NOT NULL REFERENCES guard_sessions(id),
  scheduled_shift_start TIMESTAMP,
  scheduled_shift_end TIMESTAMP,
  category VARCHAR(40) NOT NULL,
  priority VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'NEW',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  read_by_admin_id INTEGER REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_admin_id INTEGER REFERENCES users(id),
  CONSTRAINT guard_shift_reports_category_chk CHECK (
    category IN (
      'OBSERVATION',
      'FACILITY_EQUIPMENT',
      'SECURITY_CONCERN',
      'HANDOVER_NOTE',
      'OTHER'
    )
  ),
  CONSTRAINT guard_shift_reports_priority_chk CHECK (
    priority IN ('NORMAL', 'IMPORTANT')
  ),
  CONSTRAINT guard_shift_reports_status_chk CHECK (
    status IN ('NEW', 'READ', 'ACKNOWLEDGED')
  ),
  CONSTRAINT guard_shift_reports_message_chk CHECK (
    CHAR_LENGTH(BTRIM(message)) BETWEEN 1 AND 5000
  ),
  CONSTRAINT guard_shift_reports_shift_chk CHECK (
    scheduled_shift_start IS NULL
    OR scheduled_shift_end IS NULL
    OR scheduled_shift_end > scheduled_shift_start
  )
);

CREATE INDEX IF NOT EXISTS guard_shift_reports_company_created_idx
  ON guard_shift_reports (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guard_shift_reports_site_created_idx
  ON guard_shift_reports (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guard_shift_reports_guard_created_idx
  ON guard_shift_reports (guard_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guard_shift_reports_session_created_idx
  ON guard_shift_reports (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guard_shift_reports_company_status_idx
  ON guard_shift_reports (company_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS guard_shift_report_attachments (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT NOT NULL REFERENCES guard_shift_reports(id) ON DELETE RESTRICT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  storage_path TEXT NOT NULL UNIQUE,
  original_filename TEXT,
  mime_type VARCHAR(80) NOT NULL,
  file_size BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guard_shift_report_attachment_mime_chk CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT guard_shift_report_attachment_size_chk CHECK (
    file_size > 0 AND file_size <= 10485760
  )
);

CREATE INDEX IF NOT EXISTS guard_shift_report_attachments_report_idx
  ON guard_shift_report_attachments (report_id, created_at ASC);
CREATE INDEX IF NOT EXISTS guard_shift_report_attachments_company_idx
  ON guard_shift_report_attachments (company_id, report_id);

CREATE TABLE IF NOT EXISTS guard_shift_report_events (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT NOT NULL REFERENCES guard_shift_reports(id) ON DELETE RESTRICT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  event_type VARCHAR(40) NOT NULL,
  actor_type VARCHAR(20) NOT NULL,
  actor_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guard_shift_report_event_type_chk CHECK (
    event_type IN (
      'SHIFT_REPORT_CREATED',
      'SHIFT_REPORT_READ',
      'SHIFT_REPORT_ACKNOWLEDGED'
    )
  ),
  CONSTRAINT guard_shift_report_actor_type_chk CHECK (
    actor_type IN ('GUARD', 'ADMIN')
  )
);

CREATE INDEX IF NOT EXISTS guard_shift_report_events_report_idx
  ON guard_shift_report_events (report_id, created_at ASC);
CREATE INDEX IF NOT EXISTS guard_shift_report_events_company_idx
  ON guard_shift_report_events (company_id, created_at DESC);

CREATE OR REPLACE FUNCTION protect_guard_shift_report()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shift Reports are immutable and cannot be deleted';
  END IF;

  IF NEW.report_number IS DISTINCT FROM OLD.report_number
    OR NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.guard_id IS DISTINCT FROM OLD.guard_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.scheduled_shift_start IS DISTINCT FROM OLD.scheduled_shift_start
    OR NEW.scheduled_shift_end IS DISTINCT FROM OLD.scheduled_shift_end
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.message IS DISTINCT FROM OLD.message
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Shift Report operational content is immutable';
  END IF;

  IF OLD.status = 'NEW' AND NEW.status = 'READ' THEN
    IF OLD.read_at IS NOT NULL OR OLD.read_by_admin_id IS NOT NULL
      OR NEW.read_at IS NULL OR NEW.read_by_admin_id IS NULL
      OR NEW.acknowledged_at IS NOT NULL
      OR NEW.acknowledged_by_admin_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'Invalid Shift Report READ transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'READ' AND NEW.status = 'ACKNOWLEDGED' THEN
    IF NEW.read_at IS DISTINCT FROM OLD.read_at
      OR NEW.read_by_admin_id IS DISTINCT FROM OLD.read_by_admin_id
      OR NEW.acknowledged_at IS NULL
      OR NEW.acknowledged_by_admin_id IS NULL
    THEN
      RAISE EXCEPTION 'Invalid Shift Report ACKNOWLEDGED transition';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid Shift Report status transition';
END;
$$;

DROP TRIGGER IF EXISTS guard_shift_reports_immutable_trigger
  ON guard_shift_reports;
CREATE TRIGGER guard_shift_reports_immutable_trigger
  BEFORE UPDATE OR DELETE ON guard_shift_reports
  FOR EACH ROW EXECUTE FUNCTION protect_guard_shift_report();

CREATE OR REPLACE FUNCTION prevent_guard_shift_report_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Shift Report attachments and audit events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS guard_shift_report_attachments_immutable_trigger
  ON guard_shift_report_attachments;
CREATE TRIGGER guard_shift_report_attachments_immutable_trigger
  BEFORE UPDATE OR DELETE ON guard_shift_report_attachments
  FOR EACH ROW EXECUTE FUNCTION prevent_guard_shift_report_child_mutation();

DROP TRIGGER IF EXISTS guard_shift_report_events_immutable_trigger
  ON guard_shift_report_events;
CREATE TRIGGER guard_shift_report_events_immutable_trigger
  BEFORE UPDATE OR DELETE ON guard_shift_report_events
  FOR EACH ROW EXECUTE FUNCTION prevent_guard_shift_report_child_mutation();
