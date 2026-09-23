const REVERSE_GEOCODE_MIN_DISTANCE_METERS = 100;
const REVERSE_GEOCODE_RETRY_INTERVAL_MS = 10 * 60 * 1000;

const GUARD_LOCATION_UPDATE_SQL = `
  UPDATE guard_sessions
  SET
    last_latitude = $1::numeric,
    last_longitude = $2::numeric,
    last_location_accuracy = $3::integer,
    last_speed = $4::numeric,
    last_battery_level = $5::integer,
    last_location_address = COALESCE($6::text, last_location_address),
    last_geocoded_latitude = CASE
      WHEN $6::text IS NOT NULL THEN $1::double precision
      ELSE last_geocoded_latitude
    END,
    last_geocoded_longitude = CASE
      WHEN $6::text IS NOT NULL THEN $2::double precision
      ELSE last_geocoded_longitude
    END,
    last_reverse_geocode_at = CASE
      WHEN $9::boolean THEN NOW()
      ELSE last_reverse_geocode_at
    END,
    last_location_at = NOW()
  WHERE guard_id = $7
    AND id = $8
    AND logout_time IS NULL
`;

function validCoordinate(value) {
  return Number.isFinite(Number(value));
}

function parseGuardCoordinates(latitude, longitude) {
  if (
    latitude === null
    || latitude === undefined
    || longitude === null
    || longitude === undefined
    || (typeof latitude === "string" && latitude.trim() === "")
    || (typeof longitude === "string" && longitude.trim() === "")
  ) {
    return null;
  }

  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);

  if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)) {
    return null;
  }

  return { latitude: parsedLatitude, longitude: parsedLongitude };
}

function distanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  if (![latitudeA, longitudeA, latitudeB, longitudeB].every(validCoordinate)) {
    return Number.POSITIVE_INFINITY;
  }

  const radians = (degrees) => Number(degrees) * Math.PI / 180;
  const earthRadiusMeters = 6371000;
  const latDelta = radians(Number(latitudeB) - Number(latitudeA));
  const lonDelta = radians(Number(longitudeB) - Number(longitudeA));
  const startLatitude = radians(latitudeA);
  const endLatitude = radians(latitudeB);
  const haversine =
    Math.sin(latDelta / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude)
      * Math.sin(lonDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function shouldReverseGeocodeLocation({
  previousLatitude,
  previousLongitude,
  previousAccuracy,
  previousAddress,
  previousGeocodedAt,
  latitude,
  longitude,
  accuracy,
  now = Date.now(),
}) {
  const movement = distanceMeters(
    previousLatitude,
    previousLongitude,
    latitude,
    longitude
  );
  const accuracyThreshold = Math.max(
    Number(previousAccuracy) || 0,
    Number(accuracy) || 0
  ) * 2;
  const movementThreshold = Math.max(
    REVERSE_GEOCODE_MIN_DISTANCE_METERS,
    accuracyThreshold
  );

  if (previousAddress && movement >= movementThreshold) return true;
  if (previousAddress) return false;

  const previousAttempt = new Date(previousGeocodedAt).getTime();
  const currentTime = new Date(now).getTime();
  return !Number.isFinite(previousAttempt)
    || !Number.isFinite(currentTime)
    || currentTime - previousAttempt >= REVERSE_GEOCODE_RETRY_INTERVAL_MS;
}

module.exports = {
  GUARD_LOCATION_UPDATE_SQL,
  REVERSE_GEOCODE_MIN_DISTANCE_METERS,
  REVERSE_GEOCODE_RETRY_INTERVAL_MS,
  distanceMeters,
  parseGuardCoordinates,
  shouldReverseGeocodeLocation,
};
