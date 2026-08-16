BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS access_mode VARCHAR(20) NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS temporary_access_duration_hours INTEGER,
  ADD COLUMN IF NOT EXISTS temporary_access_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temporary_access_group_id UUID,
  ADD COLUMN IF NOT EXISTS temporary_access_label VARCHAR(120),
  ADD COLUMN IF NOT EXISTS temporary_access_revoked_at TIMESTAMPTZ;

ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS access_mode VARCHAR(20) NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS temporary_access_duration_hours INTEGER,
  ADD COLUMN IF NOT EXISTS temporary_access_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temporary_access_group_id UUID,
  ADD COLUMN IF NOT EXISTS temporary_access_label VARCHAR(120),
  ADD COLUMN IF NOT EXISTS temporary_access_revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_temporary_access_group_idx
  ON users (temporary_access_group_id)
  WHERE temporary_access_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS guards_temporary_access_group_idx
  ON guards (temporary_access_group_id)
  WHERE temporary_access_group_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_access_mode_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_access_mode_check
      CHECK (access_mode IN ('standard', 'read_only'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'guards_access_mode_check'
      AND conrelid = 'guards'::regclass
  ) THEN
    ALTER TABLE guards
      ADD CONSTRAINT guards_access_mode_check
      CHECK (access_mode IN ('standard', 'read_only'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_temporary_access_duration_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_temporary_access_duration_check
      CHECK (
        temporary_access_duration_hours IS NULL
        OR temporary_access_duration_hours > 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'guards_temporary_access_duration_check'
      AND conrelid = 'guards'::regclass
  ) THEN
    ALTER TABLE guards
      ADD CONSTRAINT guards_temporary_access_duration_check
      CHECK (
        temporary_access_duration_hours IS NULL
        OR temporary_access_duration_hours > 0
      );
  END IF;
END $$;

COMMIT;