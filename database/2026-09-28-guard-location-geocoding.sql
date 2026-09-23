ALTER TABLE guard_sessions
  ADD COLUMN IF NOT EXISTS last_geocoded_latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_geocoded_longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_reverse_geocode_at TIMESTAMPTZ;

UPDATE guard_sessions
SET
  last_geocoded_latitude = last_latitude,
  last_geocoded_longitude = last_longitude,
  last_reverse_geocode_at = COALESCE(last_location_at, NOW())
WHERE last_location_address IS NOT NULL
  AND last_geocoded_latitude IS NULL
  AND last_geocoded_longitude IS NULL;
