/**
 * Level progression — single source of truth for the XP curve.
 *
 * Reaching level n costs 100 * n XP, so the total XP needed for level n is
 * 100 * (2 + 3 + ... + n) = 50 * n * (n + 1) - 100.
 *
 *   niveau 2 →    200 XP      niveau 5 →  1 400 XP
 *   niveau 3 →    500 XP      niveau 10 → 5 400 XP
 *   niveau 4 →    900 XP      niveau 15 → 11 900 XP
 *
 * Levels are unbounded: the curve keeps growing instead of capping out.
 *
 * The client mirrors this file in `client/src/utils/levels.ts` so it can draw
 * progress bars offline — keep both in sync when the curve changes.
 */

const XP_STEP = 100;

/** Level bands, highest first: the first entry the level reaches wins. */
const LEVEL_TIERS = [
  { minLevel: 12, title: 'Élite' },
  { minLevel: 9, title: 'Expert' },
  { minLevel: 7, title: 'Athlète' },
  { minLevel: 5, title: 'Confirmé' },
  { minLevel: 3, title: 'Amateur' },
  { minLevel: 1, title: 'Débutant' },
];

const DEFAULT_TITLE = 'Débutant';

/** Total cumulated XP required to reach `level`. Level 1 starts at 0. */
function totalXpForLevel(level) {
  if (level <= 1) return 0;
  return (XP_STEP / 2) * level * (level + 1) - XP_STEP;
}

function titleForLevel(level) {
  const tier = LEVEL_TIERS.find((entry) => level >= entry.minLevel);
  return tier ? tier.title : DEFAULT_TITLE;
}

/**
 * Level reached with `xp` total experience.
 *
 * Solving 50n² + 50n - (100 + xp) = 0 gives the level directly, but floating
 * point can land just under an exact threshold, so the result is corrected
 * against the real thresholds rather than trusted blindly.
 */
function getLevelFromXp(xp) {
  const safeXp = Number.isFinite(xp) && xp > 0 ? xp : 0;
  const estimate = Math.floor(
    (-XP_STEP / 2 + Math.sqrt((XP_STEP / 2) ** 2 + 2 * XP_STEP * (XP_STEP + safeXp))) / XP_STEP,
  );

  let level = Math.max(1, estimate);
  while (totalXpForLevel(level + 1) <= safeXp) level += 1;
  while (level > 1 && totalXpForLevel(level) > safeXp) level -= 1;
  return level;
}

/** Everything the UI needs to render a level badge and its progress bar. */
function getLevelProgress(xp) {
  const totalXp = Number.isFinite(xp) && xp > 0 ? xp : 0;
  const level = getLevelFromXp(totalXp);
  const levelStartXp = totalXpForLevel(level);
  const nextLevelXp = totalXpForLevel(level + 1);
  const xpForThisLevel = nextLevelXp - levelStartXp;
  const xpIntoLevel = totalXp - levelStartXp;

  return {
    level,
    title: titleForLevel(level),
    totalXp,
    xpIntoLevel,
    xpForThisLevel,
    xpToNextLevel: xpForThisLevel - xpIntoLevel,
    progress: xpForThisLevel > 0 ? xpIntoLevel / xpForThisLevel : 0,
  };
}

module.exports = {
  LEVEL_TIERS,
  XP_STEP,
  getLevelFromXp,
  getLevelProgress,
  titleForLevel,
  totalXpForLevel,
};
