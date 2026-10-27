const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getLevelFromXp,
  getLevelProgress,
  titleForLevel,
  totalXpForLevel,
} = require('../src/utils/levels');

test('level 1 starts at zero XP', () => {
  assert.equal(totalXpForLevel(1), 0);
  assert.equal(getLevelFromXp(0), 1);
});

test('the curve costs 100 x n XP per level', () => {
  assert.equal(totalXpForLevel(2), 200);
  assert.equal(totalXpForLevel(3), 500);
  assert.equal(totalXpForLevel(5), 1400);
  assert.equal(totalXpForLevel(10), 5400);
  assert.equal(totalXpForLevel(15), 11900);
});

test('every threshold inverts back to its own level', () => {
  for (let level = 1; level <= 60; level += 1) {
    const threshold = totalXpForLevel(level);
    assert.equal(getLevelFromXp(threshold), level, `seuil du niveau ${level}`);
  }
});

test('one XP short of a threshold stays on the previous level', () => {
  for (let level = 2; level <= 60; level += 1) {
    const threshold = totalXpForLevel(level);
    assert.equal(getLevelFromXp(threshold - 1), level - 1, `seuil-1 du niveau ${level}`);
  }
});

test('missing or negative XP falls back to level 1', () => {
  assert.equal(getLevelFromXp(-50), 1);
  assert.equal(getLevelFromXp(NaN), 1);
  assert.equal(getLevelFromXp(undefined), 1);
  assert.equal(getLevelProgress(undefined).totalXp, 0);
});

test('titles follow the level bands', () => {
  assert.equal(titleForLevel(1), 'Débutant');
  assert.equal(titleForLevel(2), 'Débutant');
  assert.equal(titleForLevel(3), 'Amateur');
  assert.equal(titleForLevel(5), 'Confirmé');
  assert.equal(titleForLevel(7), 'Athlète');
  assert.equal(titleForLevel(9), 'Expert');
  assert.equal(titleForLevel(12), 'Élite');
  assert.equal(titleForLevel(99), 'Élite');
});

test('progress reports the position inside the current level', () => {
  // 200 XP opens level 2, which then costs 300 XP to clear.
  const progress = getLevelProgress(350);
  assert.equal(progress.level, 2);
  assert.equal(progress.xpIntoLevel, 150);
  assert.equal(progress.xpForThisLevel, 300);
  assert.equal(progress.xpToNextLevel, 150);
  assert.equal(progress.progress, 0.5);
});

test('progress resets to zero right after levelling up', () => {
  const progress = getLevelProgress(totalXpForLevel(4));
  assert.equal(progress.level, 4);
  assert.equal(progress.xpIntoLevel, 0);
  assert.equal(progress.progress, 0);
});

test('a single run can cross several levels', () => {
  // 900 XP in one go takes a fresh runner from level 1 to level 4.
  assert.equal(getLevelFromXp(0), 1);
  assert.equal(getLevelFromXp(0 + 900), 4);
});
