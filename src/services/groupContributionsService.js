const Group = require('../models/Group');
const GroupMember = require('../models/GroupMember');
const GroupRunContribution = require('../models/GroupRunContribution');
const GroupChallenge = require('../models/GroupChallenge');
const GroupChallengeParticipant = require('../models/GroupChallengeParticipant');
const GroupPost = require('../models/GroupPost');
const GroupPostComment = require('../models/GroupPostComment');
const GroupReport = require('../models/GroupReport');
const { getPeriodId, localDayKey } = require('../utils/time');

const MINIMUM_CHALLENGE_RUN_METRES = 0;

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/**
 * Records a valid GPS run's automatic contribution to all groups where the
 * runner is an active member and has enabled autoContributeKm, and advances
 * any enrolled group challenges.
 *
 * Safe to call multiple times for the same run (idempotent).
 */
async function processGroupRunContributions(userId, run) {
  if (!run || !run._id || !(run.distanceMetres >= 0)) return;

  const memberships = await GroupMember.find({
    user: userId,
    status: 'active',
  })
    .select('group autoContributeKm joinedAt')
    .lean();

  if (memberships.length === 0) return;

  const startedAt = new Date(run.startedAt);
  const finishedAt = new Date(run.finishedAt || run.startedAt);
  const localDay = localDayKey(startedAt);
  const weekPeriodId = getPeriodId(startedAt, 'hebdomadaire');
  const monthPeriodId = getPeriodId(startedAt, 'mensuel');

  const activeGroupIds = [];

  for (const membership of memberships) {
    activeGroupIds.push(membership.group);

    // Respect user privacy setting per group
    if (membership.autoContributeKm === false) continue;

    try {
      const existing = await GroupRunContribution.findOne({
        group: membership.group,
        run: run._id,
      })
        .select('_id')
        .lean();

      if (!existing) {
        await GroupRunContribution.create({
          group: membership.group,
          user: userId,
          run: run._id,
          distanceMetres: run.distanceMetres,
          durationSeconds: run.durationSeconds || 0,
          startedAt,
          localDay,
          weekPeriodId,
          monthPeriodId,
        });

        await Group.updateOne(
          { _id: membership.group },
          {
            $inc: {
              totalDistanceMetres: run.distanceMetres,
              totalRunsCount: 1,
            },
          },
        );
      }
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        console.error('Erreur contribution groupe:', error);
      }
    }
  }

  // Advance Group Challenges the user has joined
  const participations = await GroupChallengeParticipant.find({
    user: userId,
    group: { $in: activeGroupIds },
    countedRuns: { $ne: run._id },
  }).lean();

  if (participations.length === 0) return;

  const challengeIds = participations.map((p) => p.challenge);
  const challenges = await GroupChallenge.find({
    _id: { $in: challengeIds },
    isActive: true,
    startDate: { $lte: finishedAt },
    endDate: { $gte: startedAt },
  }).lean();

  const challengeById = new Map(challenges.map((c) => [c._id.toString(), c]));

  for (const participation of participations) {
    const challenge = challengeById.get(participation.challenge.toString());
    if (!challenge) continue;

    // Only runs completed after the member joined the challenge count (with 5 min tolerance)
    if (finishedAt.getTime() + 5 * 60 * 1000 < new Date(participation.joinedAt).getTime()) {
      continue;
    }

    let delta = 0;
    if (challenge.goalType === 'distance') {
      delta = run.distanceMetres;
    } else if (challenge.goalType === 'nb_courses') {
      if (run.distanceMetres >= MINIMUM_CHALLENGE_RUN_METRES) {
        delta = 1;
      }
    }

    if (delta <= 0) continue;

    const updatedParticipant = await GroupChallengeParticipant.findOneAndUpdate(
      {
        _id: participation._id,
        countedRuns: { $ne: run._id },
      },
      {
        $inc: { progressValue: delta },
        $push: { countedRuns: run._id },
      },
      { returnDocument: 'after' },
    );

    if (!updatedParticipant) continue;

    if (challenge.mode === 'individuel') {
      if (
        updatedParticipant.status === 'en_cours' &&
        updatedParticipant.progressValue >= challenge.goalValue
      ) {
        await GroupChallengeParticipant.updateOne(
          { _id: participation._id, status: 'en_cours' },
          { $set: { status: 'termine', completedAt: new Date() } },
        );
      }
    } else if (challenge.mode === 'collectif') {
      const updatedChallenge = await GroupChallenge.findOneAndUpdate(
        {
          _id: challenge._id,
          collectiveCountedRuns: { $ne: run._id },
        },
        {
          $inc: { collectiveProgressValue: delta },
          $push: { collectiveCountedRuns: run._id },
        },
        { returnDocument: 'after' },
      );

      const newCollectiveTotal =
        updatedChallenge?.collectiveProgressValue ?? challenge.collectiveProgressValue + delta;

      if (newCollectiveTotal >= challenge.goalValue) {
        await GroupChallengeParticipant.updateMany(
          { challenge: challenge._id, status: 'en_cours' },
          { $set: { status: 'termine', completedAt: new Date() } },
        );
      }
    }
  }
}

/**
 * Removes a deleted or invalidated run from all group leaderboards, totals,
 * challenges, and group feeds (Section 9: "Les activités supprimées ou
 * invalidées sont retirées des classements").
 */
async function revokeGroupRunContributions(run) {
  if (!run || !run._id) return;
  const runId = run._id;

  // 1. Remove GroupRunContribution rows and decrement group totals
  const contributions = await GroupRunContribution.find({ run: runId }).lean();
  for (const contrib of contributions) {
    const deleted = await GroupRunContribution.deleteOne({ _id: contrib._id });
    if (deleted.deletedCount === 1) {
      await Group.updateOne(
        { _id: contrib.group },
        [
          {
            $set: {
              totalDistanceMetres: {
                $max: [0, { $subtract: [{ $ifNull: ['$totalDistanceMetres', 0] }, contrib.distanceMetres] }],
              },
              totalRunsCount: {
                $max: [0, { $subtract: [{ $ifNull: ['$totalRunsCount', 0] }, 1] }],
              },
            },
          },
        ],
        { updatePipeline: true },
      );
    }
  }

  // 2. Revert GroupChallengeParticipant & GroupChallenge progress
  const affectedParticipants = await GroupChallengeParticipant.find({
    countedRuns: runId,
  }).lean();

  if (affectedParticipants.length > 0) {
    const challengeIds = affectedParticipants.map((p) => p.challenge);
    const challenges = await GroupChallenge.find({ _id: { $in: challengeIds } }).lean();
    const challengeById = new Map(challenges.map((c) => [c._id.toString(), c]));

    for (const participant of affectedParticipants) {
      const challenge = challengeById.get(participant.challenge.toString());
      if (!challenge) continue;

      const delta = challenge.goalType === 'distance' ? run.distanceMetres : 1;
      const nextProgress = Math.max(0, (participant.progressValue || 0) - delta);

      await GroupChallengeParticipant.updateOne(
        { _id: participant._id, countedRuns: runId },
        {
          $set: {
            progressValue: nextProgress,
            ...(challenge.mode === 'individuel' && nextProgress < challenge.goalValue
              ? { status: 'en_cours', completedAt: null }
              : {}),
          },
          $pull: { countedRuns: runId },
        },
      );

      if (challenge.mode === 'collectif') {
        const nextCollective = Math.max(0, (challenge.collectiveProgressValue || 0) - delta);
        await GroupChallenge.updateOne(
          { _id: challenge._id, collectiveCountedRuns: runId },
          {
            $set: { collectiveProgressValue: nextCollective },
            $pull: { collectiveCountedRuns: runId },
          },
        );
        if (nextCollective < challenge.goalValue) {
          await GroupChallengeParticipant.updateMany(
            { challenge: challenge._id, status: 'termine' },
            { $set: { status: 'en_cours', completedAt: null } },
          );
        }
      }
    }
  }

  // 3. Delete any GroupPost (and its comments/reports) that shared this run
  const posts = await GroupPost.find({ run: runId }).select('_id').lean();
  if (posts.length > 0) {
    const postIds = posts.map((p) => p._id);
    await Promise.all([
      GroupPostComment.deleteMany({ post: { $in: postIds } }),
      GroupReport.deleteMany({ post: { $in: postIds } }),
      GroupPost.deleteMany({ _id: { $in: postIds } }),
    ]);
  }
}

module.exports = {
  processGroupRunContributions,
  revokeGroupRunContributions,
};

