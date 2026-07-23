const EARTH_RADIUS_METRES = 6_371_008.8;

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

const calculateDistanceMetres = (routePoints) => {
  let distanceMetres = 0;

  for (let index = 1; index < routePoints.length; index += 1) {
    distanceMetres += haversineDistanceMetres(routePoints[index - 1], routePoints[index]);
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
      const speed = Number.isFinite(point.speed) && point.speed > 0 ? point.speed : 0;
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
  calculateDistanceMetres,
  calculateRunMetrics,
  haversineDistanceMetres,
  round,
};
