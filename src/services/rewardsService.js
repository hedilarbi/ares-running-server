const User = require('../models/User');
const Badge = require('../models/Badge');
const Defi = require('../models/Defi');
const UserBadge = require('../models/UserBadge');
const UserDefi = require('../models/UserDefi');
const Run = require('../models/Run');
const { getLevelProgress } = require('../utils/levels');
const {
  APP_TIMEZONE,
  DAY_MS,
  getPeriodId,
  localDayKey,
  localParts,
} = require('../utils/time');

// A run shorter than this still saves and earns its distance XP, but does not
// count as "a run" for nb_courses badges and défis: otherwise ten taps on
// start/stop would complete "10 courses".
const MINIMUM_COUNTED_RUN_METRES = 500;

// A run uploaded late (offline phone) still advances a défi of a past period
// if it ended this recently, so a run finished at 23:55 and synced at 00:05
// counts. Older runs cannot be backdated into closed periods.
const LATE_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

const XP_PER_KM = 10;

/** Defi goal types the engine can measure. 'custom' has no automatic rule. */
const AUTOMATIC_DEFI_GOALS = new Set(['distance', 'nb_courses', 'vitesse']);

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/** Conditions the engine cannot evaluate yet. A badge using one never unlocks. */
function hasUnsupportedCondition(conditions) {
  if (!conditions) return false;
  return (conditions.uniqueLocations || 0) > 0 || (conditions.ranking || 'none') !== 'none';
}

/** Conditions that describe a single run: when it started and how long it lasted. */
function runMatchesFilters(run, conditions) {
  if (!conditions) return true;

  const { hour } = localParts(run.startedAt);
  if (conditions.timeConstraint === 'before_8am' && hour >= 8) return false;
  if (conditions.timeConstraint === 'after_8pm' && hour < 20) return false;

  if (conditions.durationMinutes && run.durationSeconds < conditions.durationMinutes * 60) {
    return false;
  }
  return true;
}

/** Mongo filter equivalent of runMatchesFilters, for cumulative totals. */
function runFiltersQuery(conditions) {
  const query = {};
  if (conditions?.durationMinutes) {
    query.durationSeconds = { $gte: conditions.durationMinutes * 60 };
  }
  const hourOf = { $hour: { date: '$startedAt', timezone: APP_TIMEZONE } };
  if (conditions?.timeConstraint === 'before_8am') query.$expr = { $lt: [hourOf, 8] };
  if (conditions?.timeConstraint === 'after_8pm') query.$expr = { $gte: [hourOf, 20] };
  return query;
}

/** The runner ran on each of the `days` local days ending with this run's day. */
async function ranConsecutiveDays(userId, run, days) {
  const runs = await Run.find({
    user: userId,
    distanceMetres: { $gte: MINIMUM_COUNTED_RUN_METRES },
    // One spare day on each side: local days do not align with UTC ones.
    startedAt: {
      $gte: new Date(new Date(run.startedAt).getTime() - (days + 1) * DAY_MS),
      $lte: new Date(new Date(run.startedAt).getTime() + DAY_MS),
    },
  })
    .select('startedAt')
    .lean();

  const ranOn = new Set(runs.map((entry) => localDayKey(entry.startedAt)));
  for (let offset = 0; offset < days; offset += 1) {
    if (!ranOn.has(localDayKey(run.startedAt, offset))) return false;
  }
  return true;
}

/** Longer than the run that started just before it (not the last one uploaded). */
async function beatsPreviousRun(userId, run) {
  const previousRun = await Run.findOne({
    user: userId,
    _id: { $ne: run._id },
    startedAt: { $lt: run.startedAt },
  })
    .sort({ startedAt: -1 })
    .select('distanceMetres')
    .lean();

  return Boolean(previousRun) && run.distanceMetres > previousRun.distanceMetres;
}

/** Conditions that need the runner's history around this run. */
async function runMeetsTriggers(userId, run, conditions) {
  if (conditions?.consecutiveDays > 0 && !(await ranConsecutiveDays(userId, run, conditions.consecutiveDays))) {
    return false;
  }
  if (conditions?.beatPrevious && !(await beatsPreviousRun(userId, run))) return false;
  return true;
}

/** Distance and run count over the runs that pass the badge's per-run filters. */
async function cumulativeTotals(userId, conditions) {
  const [totals] = await Run.aggregate([
    { $match: { user: userId, ...runFiltersQuery(conditions) } },
    {
      $group: {
        _id: null,
        distanceMetres: { $sum: '$distanceMetres' },
        countedRuns: {
          $sum: { $cond: [{ $gte: ['$distanceMetres', MINIMUM_COUNTED_RUN_METRES] }, 1, 0] },
        },
      },
    },
  ]);
  return { distanceMetres: totals?.distanceMetres || 0, countedRuns: totals?.countedRuns || 0 };
}

async function badgeUnlockedBy(userId, run, badge) {
  const conditions = badge.conditionConfig;
  if (badge.criteriaType === 'manuel' || hasUnsupportedCondition(conditions)) return false;

  if (badge.criteriaType === 'distance_course' || badge.criteriaType === 'vitesse_max') {
    if (!runMatchesFilters(run, conditions)) return false;
    const value = badge.criteriaType === 'distance_course' ? run.distanceMetres : run.maxSpeedMps;
    if (value < badge.criteriaThreshold) return false;
    return runMeetsTriggers(userId, run, conditions);
  }

  if (badge.criteriaType === 'distance_totale' || badge.criteriaType === 'nb_courses') {
    const totals = await cumulativeTotals(userId, conditions);
    const value = badge.criteriaType === 'distance_totale' ? totals.distanceMetres : totals.countedRuns;
    if (value < badge.criteriaThreshold) return false;
    return runMeetsTriggers(userId, run, conditions);
  }

  return false;
}

async function awardBadges(userId, run) {
  const [activeBadges, owned] = await Promise.all([
    Badge.find({ isActive: true }).lean(),
    UserBadge.find({ user: userId }).select('badge').lean(),
  ]);
  const ownedIds = new Set(owned.map((entry) => entry.badge.toString()));

  for (const badge of activeBadges) {
    if (ownedIds.has(badge._id.toString())) continue;
    if (!(await badgeUnlockedBy(userId, run, badge))) continue;

    try {
      await UserBadge.create({
        user: userId,
        badge: badge._id,
        sourceRun: run._id,
        xpAwarded: badge.xpReward || 0,
      });
    } catch (error) {
      // A concurrent run unlocked it first: that run gets the XP.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
}

/** How much this run adds to a défi, or null when it does not count. */
function defiContribution(defi, run) {
  if (defi.goalType === 'distance') return run.distanceMetres;
  if (defi.goalType === 'nb_courses') return run.distanceMetres >= MINIMUM_COUNTED_RUN_METRES ? 1 : null;
  // Average speed: a single GPS spike cannot reach it, unlike the maximum.
  if (defi.goalType === 'vitesse') return run.averageSpeedMps;
  return null;
}

/** Best-of défis keep the run's value instead of adding it up. */
function defiKeepsBest(defi) {
  return defi.goalType === 'vitesse' || (defi.goalType === 'distance' && defi.conditionConfig?.isPerRun);
}

/**
 * Marks every en_cours participation of `filter` that reached the goal as
 * done. The status check makes it pay once, whoever gets there first.
 */
async function completeReachedParticipations(defi, filter, completedByRun = null) {
  const reached = await UserDefi.find({
    ...filter,
    defi: defi._id,
    status: 'en_cours',
    progressValue: { $gte: defi.goalValue },
  })
    .select('_id user')
    .lean();

  const paid = [];
  for (const participation of reached) {
    const result = await UserDefi.updateOne(
      { _id: participation._id, status: 'en_cours' },
      {
        $set: {
          status: 'termine',
          completedAt: new Date(),
          completedByRun,
          xpAwarded: defi.xpReward || 0,
        },
      },
    );
    if (result.modifiedCount === 1) paid.push(participation.user);
  }
  return paid;
}

async function advanceDefis(userId, run) {
  // A run can only advance the period it belongs to, and only while that
  // period is open (or it has just closed and the upload was late).
  const ranRecently = Date.now() - new Date(run.finishedAt).getTime() <= LATE_UPLOAD_GRACE_MS;
  const activeDefis = await Defi.find({ isActive: true, goalValue: { $gt: 0 } }).lean();

  for (const defi of activeDefis) {
    if (!AUTOMATIC_DEFI_GOALS.has(defi.goalType)) continue;
    if (hasUnsupportedCondition(defi.conditionConfig)) continue;

    const periodId = getPeriodId(run.startedAt, defi.period);
    if (!ranRecently && periodId !== getPeriodId(new Date(), defi.period)) continue;

    const contribution = defiContribution(defi, run);
    if (contribution === null) continue;
    if (!runMatchesFilters(run, defi.conditionConfig)) continue;
    if (!(await runMeetsTriggers(userId, run, defi.conditionConfig))) continue;

    const key = { user: userId, defi: defi._id, periodId };
    try {
      await UserDefi.updateOne(
        key,
        { $setOnInsert: { progressValue: 0, status: 'en_cours', joinedAt: new Date() } },
        { upsert: true },
      );
    } catch (error) {
      // Two runs enrolled the user at the same time: the row exists now.
      if (!isDuplicateKeyError(error)) throw error;
    }

    // `countedRuns` makes a retried pass skip this run instead of adding it twice.
    await UserDefi.updateOne(
      { ...key, status: 'en_cours', countedRuns: { $ne: run._id } },
      {
        ...(defiKeepsBest(defi)
          ? { $max: { progressValue: contribution } }
          : { $inc: { progressValue: contribution } }),
        $push: { countedRuns: run._id },
      },
    );

    await completeReachedParticipations(defi, key, run._id);
  }
}

/** Keeps the stored level title in step with the XP, without racing other writers. */
async function syncLevelTitle(userId) {
  const user = await User.findById(userId).select('xp level').lean();
  if (!user) return null;
  const level = getLevelProgress(user.xp || 0);
  if (user.level !== level.title) {
    // Only if the XP did not move meanwhile: the writer that moved it syncs again.
    await User.updateOne({ _id: userId, xp: user.xp }, { $set: { level: level.title } });
  }
  return level;
}

/** Adds (or, when negative, removes) XP atomically. XP never drops below zero. */
async function addXp(userId, amount) {
  if (amount !== 0) {
    await User.updateOne(
      { _id: userId },
      [{ $set: { xp: { $max: [0, { $add: [{ $ifNull: ['$xp', 0] }, amount] }] } } }],
      { updatePipeline: true },
    );
  }
  return syncLevelTitle(userId);
}

/**
 * Processes rewards for a saved run. Safe to call again for the same run: the
 * badges and défis it already earned are found again instead of re-earned,
 * and its XP is only added once.
 */
async function processRunRewards(userId, run) {
  const user = await User.findById(userId).select('xp').lean();
  if (!user) {
    return { earnedXp: 0, unlockedBadges: [], completedDefis: [], level: getLevelProgress(0), levelUp: null };
  }

  await awardBadges(userId, run);
  await advanceDefis(userId, run);

  const [badgeRows, defiRows] = await Promise.all([
    UserBadge.find({ user: userId, sourceRun: run._id }).populate('badge').lean(),
    UserDefi.find({ user: userId, completedByRun: run._id }).populate('defi').lean(),
  ]);

  const baseXp = Math.floor((run.distanceMetres / 1000) * XP_PER_KM);
  const earnedXp =
    baseXp +
    badgeRows.reduce((sum, row) => sum + (row.xpAwarded || 0), 0) +
    defiRows.reduce((sum, row) => sum + (row.xpAwarded || 0), 0);

  // Claim the run before paying: two concurrent passes cannot both match.
  const claim = await Run.updateOne(
    { _id: run._id, rewardsProcessedAt: { $type: 'null' } },
    { $set: { rewardsProcessedAt: new Date(), xpAwarded: earnedXp } },
  );
  const level = claim.modifiedCount === 1 ? await addXp(userId, earnedXp) : await syncLevelTitle(userId);

  const levelAfter = level || getLevelProgress(0);
  const levelBefore = getLevelProgress(Math.max(0, levelAfter.totalXp - earnedXp));

  return {
    earnedXp,
    unlockedBadges: badgeRows.map((row) => row.badge).filter(Boolean),
    completedDefis: defiRows.map((row) => row.defi).filter(Boolean),
    level: levelAfter,
    // A single run can cross several levels, hence from/to rather than a flag.
    levelUp:
      levelAfter.level > levelBefore.level
        ? {
            fromLevel: levelBefore.level,
            toLevel: levelAfter.level,
            fromTitle: levelBefore.title,
            toTitle: levelAfter.title,
            titleChanged: levelAfter.title !== levelBefore.title,
          }
        : null,
  };
}

/** Runs of this user whose reward pass failed earlier, oldest first. */
async function processPendingRewards(userId, { limit = 5 } = {}) {
  const pending = await Run.find({ user: userId, rewardsProcessedAt: { $type: 'null' } })
    .sort({ startedAt: 1 })
    .limit(limit);
  for (const run of pending) {
    await processRunRewards(userId, run);
  }
}

/** Whether the run's reward pass has not completed yet. */
async function hasPendingRewards(runId) {
  return Boolean(await Run.exists({ _id: runId, rewardsProcessedAt: { $type: 'null' } }));
}

/**
 * Pays the users whose current-period progress already meets a défi's goal,
 * e.g. after an admin lowered it.
 */
async function completeReachedDefi(defi) {
  if (!defi.isActive || !(defi.goalValue > 0) || !AUTOMATIC_DEFI_GOALS.has(defi.goalType)) return;
  const paidUsers = await completeReachedParticipations(defi, {
    periodId: getPeriodId(new Date(), defi.period),
  });
  for (const userId of paidUsers) await addXp(userId, defi.xpReward || 0);
}

/**
 * Takes back the XP paid by these UserBadge / UserDefi rows, before they are
 * deleted. Pass lean rows: those saved before `xpAwarded` existed lack the
 * field and fall back to `fallbackXp`.
 */
async function revokeAwardedXp(rows, fallbackXp) {
  const byUser = new Map();
  for (const row of rows) {
    // A défi pays only once completed; a badge row always paid.
    if (row.status !== undefined && row.status !== 'termine') continue;
    const paid = row.xpAwarded ?? fallbackXp;
    if (!paid) continue;
    const key = row.user.toString();
    byUser.set(key, (byUser.get(key) || 0) + paid);
  }
  for (const [userId, amount] of byUser) await addXp(userId, -amount);
}

module.exports = {
  MINIMUM_COUNTED_RUN_METRES,
  completeReachedDefi,
  getPeriodId,
  hasPendingRewards,
  processPendingRewards,
  processRunRewards,
  revokeAwardedXp,
};
