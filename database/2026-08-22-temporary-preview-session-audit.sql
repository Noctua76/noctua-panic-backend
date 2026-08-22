BEGIN;

ALTER TABLE admin_sessions
ADD COLUMN IF NOT EXISTS session_end_reason VARCHAR(40);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'admin_sessions_session_end_reason_check'
      AND conrelid =
        'public.admin_sessions'::regclass
  ) THEN
    ALTER TABLE admin_sessions
    ADD CONSTRAINT
      admin_sessions_session_end_reason_check
    CHECK (
      session_end_reason IS NULL
      OR session_end_reason IN (
        'logout',
        'temporary_access_expired',
        'temporary_access_revoked'
      )
    );
  END IF;
END
$$;

UPDATE admin_sessions
SET session_end_reason = 'logout'
WHERE is_active = false
  AND logout_time IS NOT NULL
  AND session_duration_seconds IS NOT NULL
  AND session_end_reason IS NULL;

COMMENT ON COLUMN admin_sessions.session_end_reason IS
  'Reason the admin session ended: logout, temporary_access_expired, or temporary_access_revoked';

COMMIT;