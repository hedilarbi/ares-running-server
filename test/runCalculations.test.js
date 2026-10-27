const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateDistanceMetres,
  calculateRunMetrics,
  haversineDistanceMetres,
} = require('../src/utils/runCalculations');

test('Haversine returns zero for the same coordinate', () => {
  const point = { latitude: 37.2746, longitude: 9.8739 };
  assert.equal(haversineDistanceMetres(point, point), 0);
});

test('Haversine measures a known equatorial longitude delta', () => {
  const distance = haversineDistanceMetres(
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.001 },
  );
  assert.ok(Math.abs(distance - 111.195) < 0.01);
});

test('route distance adds every consecutive segment', () => {
  const points = [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.001 },
    { latitude: 0, longitude: 0.002 },
  ];
  assert.ok(Math.abs(calculateDistanceMetres(points) - 222.39) < 0.02);
});

test('server metrics derive speed, pace, maximum speed and calories', () => {
  const metrics = calculateRunMetrics({
    routePoints: [
      { latitude: 0, longitude: 0, speed: 1.5 },
      { latitude: 0, longitude: 0.001, speed: 2.5 },
    ],
    durationSeconds: 60,
    weightKg: 70,
  });

  assert.equal(metrics.distanceMetres, 111.2);
  assert.equal(metrics.averageSpeedMps, 1.853);
  assert.equal(metrics.maxSpeedMps, 2.5);
  assert.equal(metrics.averagePaceSecondsPerKm, 539.59);
  assert.equal(metrics.caloriesKcal, 7.78);
});

test('server metrics support a stationary run represented by one GPS point', () => {
  const metrics = calculateRunMetrics({
    routePoints: [{ latitude: 37.2746, longitude: 9.8739, speed: 0 }],
    durationSeconds: 60,
    weightKg: 70,
  });

  assert.equal(metrics.rawDistanceMetres, 0);
  assert.equal(metrics.distanceMetres, 0);
  assert.equal(metrics.averageSpeedMps, 0);
  assert.equal(metrics.maxSpeedMps, 0);
  assert.equal(metrics.averagePaceSecondsPerKm, 0);
  assert.equal(metrics.caloriesKcal, 0);
});

test('GPS jumps faster than a runner add no distance and no max speed', () => {
  const start = 1_700_000_000_000;
  const metrics = calculateRunMetrics({
    routePoints: [
      { latitude: 0, longitude: 0, timestamp: start, speed: 3 },
      // ~111 m in 30 s: a plausible 3.7 m/s.
      { latitude: 0, longitude: 0.001, timestamp: start + 30_000, speed: 3.5 },
      // ~1.1 km in 2 s: a GPS jump, and a spurious 40 m/s point speed.
      { latitude: 0, longitude: 0.011, timestamp: start + 32_000, speed: 40 },
    ],
    durationSeconds: 32,
    weightKg: 70,
  });

  assert.ok(Math.abs(metrics.distanceMetres - 111.2) < 0.1);
  assert.equal(metrics.maxSpeedMps, 3.5);
});
