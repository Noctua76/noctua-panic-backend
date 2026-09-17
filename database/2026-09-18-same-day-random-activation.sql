ALTER TABLE random_patrol_days
  ADD COLUMN IF NOT EXISTS generation_type VARCHAR(32) NOT NULL DEFAULT 'full_day';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'random_patrol_day_generation_type_chk'
  ) THEN
    ALTER TABLE random_patrol_days
      ADD CONSTRAINT random_patrol_day_generation_type_chk
      CHECK (generation_type IN ('full_day', 'partial_first_day'));
  END IF;
END $$;
