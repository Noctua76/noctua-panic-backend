CREATE INDEX IF NOT EXISTS idx_alert_events_message_id
  ON alert_events (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

