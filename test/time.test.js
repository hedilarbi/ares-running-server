const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_TIMEZONE = 'Africa/Tunis';
const { daysLeftInPeriod, getPeriodId, localDayKey, localParts } = require('../src/utils/time');

test('weekly period uses the ISO week-numbering year', () => {
  // 29 Dec 2025 is week 1 of 2026; it used to read "2025-W01" and collide
  // with the first week of January 2025.
  assert.equal(getPeriodId(new Date('2025-12-29T10:00:00Z'), 'hebdomadaire'), '2026-W01');
  assert.equal(getPeriodId(new Date('2025-01-01T10:00:00Z'), 'hebdomadaire'), '2025-W01');
  assert.equal(getPeriodId(new Date('2027-01-01T10:00:00Z'), 'hebdomadaire'), '2026-W53');
});

test('days and hours follow the app timezone, not UTC', () => {
  // 23:30 UTC on 20 Oct is 00:30 on 21 Oct in Tunis.
  const lateUtc = new Date('2026-10-20T23:30:00Z');
  assert.equal(getPeriodId(lateUtc, 'quotidien'), '2026-10-21');
  assert.equal(localParts(lateUtc).hour, 0);
  assert.equal(localDayKey(lateUtc, 1), '2026-10-20');
  // 06:30 UTC is 07:30 local: still "before 8 am".
  assert.equal(localParts(new Date('2026-10-21T06:30:00Z')).hour, 7);
});

test('days left in period', () => {
  const wednesday = new Date('2026-10-21T10:00:00Z');
  assert.equal(daysLeftInPeriod(wednesday, 'hebdomadaire'), 4);
  assert.equal(daysLeftInPeriod(wednesday, 'mensuel'), 10);
  assert.equal(daysLeftInPeriod(new Date('2026-10-25T10:00:00Z'), 'hebdomadaire'), 0);
});
