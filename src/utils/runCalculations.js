const EARTH_RADIUS_METRES = 6_371_008.8;

// Faster than any human runner (Bolt peaks near 12.4 m/s). Segments or point
// speeds above it are GPS jumps or a vehicle, and must not earn distance or
// unlock a speed badge.
const MAXIMUM_PLAUSIBLE_SPEED_MPS = 12;
// Two fixes stamped at the same instant cannot be more than a GPS wobble apart.
const MAXIMUM_INSTANT_JUMP_METRES = 25;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

/**
 * Returns the great-circle distance between two latitude/longitude points.
 */
const haversineDistanceMetres = (from, to) => {
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(haversine)));
};

/** Whether the segment between two fixes could have been covered on foot. */
const isPlausibleSegment = (from, to, segmentMetres) => {
  const elapsedSeconds = (to.timestamp - from.timestamp) / 1000;
  // Traces without timestamps (tests, imports) cannot be checked.
  if (!Number.isFinite(elapsedSeconds)) return true;
  if (elapsedSeconds <= 0) return segmentMetres <= MAXIMUM_INSTANT_JUMP_METRES;
  return segmentMetres / elapsedSeconds <= MAXIMUM_PLAUSIBLE_SPEED_MPS;
};

const calculateDistanceMetres = (routePoints) => {
  let distanceMetres = 0;

  for (let index = 1; index < routePoints.length; index += 1) {
    const from = routePoints[index - 1];
    const to = routePoints[index];
    const segmentMetres = haversineDistanceMetres(from, to);
    if (isPlausibleSegment(from, to, segmentMetres)) distanceMetres += segmentMetres;
  }

  return distanceMetres;
};

/**
 * Metrics derived on the server. Point speeds come from the native GNSS
 * provider and are used only for the maximum; distance remains Haversine.
 */
const calculateRunMetrics = ({ routePoints, durationSeconds, weightKg }) => {
  const rawDistanceMetres = calculateDistanceMetres(routePoints);
  const distanceMetres = round(rawDistanceMetres, 2);
  const averageSpeedMps = durationSeconds > 0
    ? round(rawDistanceMetres / durationSeconds, 3)
    : 0;
  const maxSpeedMps = round(
    routePoints.reduce((maximum, point) => {
      const speed = Number.isFinite(point.speed) &&
        point.speed > 0 &&
        point.speed <= MAXIMUM_PLAUSIBLE_SPEED_MPS
        ? point.speed
        : 0;
      return Math.max(maximum, speed);
    }, 0),
    3,
  );
  const averagePaceSecondsPerKm = rawDistanceMetres > 0
    ? round(durationSeconds / (rawDistanceMetres / 1000), 2)
    : 0;
  const caloriesKcal = round((rawDistanceMetres / 1000) * weightKg, 2);

  return {
    rawDistanceMetres,
    distanceMetres,
    averageSpeedMps,
    maxSpeedMps,
    averagePaceSecondsPerKm,
    caloriesKcal,
  };
};

module.exports = {
  EARTH_RADIUS_METRES,
  MAXIMUM_PLAUSIBLE_SPEED_MPS,
  calculateDistanceMetres,
  calculateRunMetrics,
  haversineDistanceMetres,
  round,
};
