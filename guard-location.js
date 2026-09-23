const REVERSE_GEOCODE_MIN_DISTANCE_METERS = 100;
const REVERSE_GEOCODE_RETRY_INTERVAL_MS = 10 * 60 * 1000;

function validCoordinate(value) {
  return Number.isFinite(Number(value));
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
  REVERSE_GEOCODE_MIN_DISTANCE_METERS,
  REVERSE_GEOCODE_RETRY_INTERVAL_MS,
  distanceMeters,
  shouldReverseGeocodeLocation,
};
