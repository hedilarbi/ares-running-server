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
