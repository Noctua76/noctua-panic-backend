CREATE TABLE IF NOT EXISTS system_health_state (
  id BIGSERIAL PRIMARY KEY,
  scope VARCHAR(20) NOT NULL CHECK (scope IN ('platform', 'tenant')),
  company_id BIGINT NOT NULL DEFAULT 0,
  service VARCHAR(80) NOT NULL,
  status VARCHAR(30) NOT NULL CHECK (
    status IN ('operational', 'degraded', 'offline', 'unknown', 'not_configured')
  ),
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error TEXT,
  response_time_ms INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, company_id, service)
);

CREATE INDEX IF NOT EXISTS idx_system_health_state_company
  ON system_health_state (company_id, service);

