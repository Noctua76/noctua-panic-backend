CREATE TABLE IF NOT EXISTS alert_recipients (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  full_name VARCHAR(255),
  phone VARCHAR(50) NOT NULL,
  sms_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  voice_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE alert_recipients
  ADD COLUMN IF NOT EXISTS company_id INTEGER,
  ADD COLUMN IF NOT EXISTS full_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS phone VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_alert_recipients_company_active
  ON alert_recipients (company_id, active);

CREATE TABLE IF NOT EXISTS alert_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  source VARCHAR(100),
  status VARCHAR(50),
  recipients_count INTEGER DEFAULT 0,
  sms_sent INTEGER DEFAULT 0,
  sms_failed INTEGER DEFAULT 0,
  voice_attempted INTEGER DEFAULT 0,
  voice_status VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS mode VARCHAR(30),
  ADD COLUMN IF NOT EXISTS company_id INTEGER,
  ADD COLUMN IF NOT EXISTS incident_id INTEGER,
  ADD COLUMN IF NOT EXISTS site_id INTEGER,
  ADD COLUMN IF NOT EXISTS guard_id INTEGER,
  ADD COLUMN IF NOT EXISTS recipient_phone VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sms_attempted INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sms_submitted INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_submitted INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_failed INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS provider_call_uuid VARCHAR(255),
  ADD COLUMN IF NOT EXISTS event_payload JSONB DEFAULT '{}'::jsonb;

UPDATE alert_events ae
SET company_id = i.company_id
FROM incidents i
WHERE ae.company_id IS NULL
  AND ae.incident_id = i.id;

UPDATE alert_events ae
SET company_id = s.company_id
FROM sites s
WHERE ae.company_id IS NULL
  AND ae.site_id = s.id;

CREATE INDEX IF NOT EXISTS idx_alert_events_company_created
  ON alert_events (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_company_type_created
  ON alert_events (company_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_call_uuid
  ON alert_events (provider_call_uuid)
  WHERE provider_call_uuid IS NOT NULL;
