const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const firebaseApp = require('../firebase');

const User = require('../models/User');
const Run = require('../models/Run');
const RunComment = require('../models/RunComment');
const Notification = require('../models/Notification');
const UserBadge = require('../models/UserBadge');
const UserDefi = require('../models/UserDefi');
const Group = require('../models/Group');
const GroupMember = require('../models/GroupMember');
const GroupRunContribution = require('../models/GroupRunContribution');
const GroupPost = require('../models/GroupPost');
const GroupPostComment = require('../models/GroupPostComment');
const GroupChallenge = require('../models/GroupChallenge');
const GroupChallengeParticipant = require('../models/GroupChallengeParticipant');
const GroupEvent = require('../models/GroupEvent');
const GroupReport = require('../models/GroupReport');
const { deleteRunPhoto } = require('../run-photo-storage');
const { revokeGroupRunContributions } = require('./groupContributionsService');

const log = (step, error) => console.error(`[account-deletion] ${step}:`, error?.message || error);

// Decrements a counter field by the number of removed rows, grouped by parent id.
async function decrementCounts(Model, field, rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const id = row[key]?.toString();
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  await Promise.all(
    [...counts].map(([id, n]) =>
      Model.updateOne({ _id: id }, [
        { $set: { [field]: { $max: [0, { $subtract: [{ $ifNull: [`$${field}`, 0] }, n] }] } } },
      ], { updatePipeline: true }),
    ),
  );
}

// Same cascade as DELETE /api/groups/:id, plus events.
async function deleteGroupsCascade(groupIds) {
  if (groupIds.length === 0) return;
  const g = { group: { $in: groupIds } };
  await Promise.all([
    GroupMember.deleteMany(g),
    GroupRunContribution.deleteMany(g),
    GroupPostComment.deleteMany(g),
    GroupPost.deleteMany(g),
    GroupChallengeParticipant.deleteMany(g),
    GroupChallenge.deleteMany(g),
    GroupEvent.deleteMany(g),
    GroupReport.deleteMany(g),
    Group.deleteMany({ _id: { $in: groupIds } }),
  ]);
}

/**
 * Permanently deletes a user and everything attached to them.
 * Order matters: contributions are revoked from groups the user does not own
 * before the runs disappear, so other members' totals and challenges stay right.
 */
async function deleteUserAccount(user) {
  const userId = user._id;

  // 1. Groups the user created disappear with them.
  const ownedGroupIds = (await Group.find({ creator: userId }).select('_id').lean()).map((g) => g._id);
  await deleteGroupsCascade(ownedGroupIds);

  // 2. Runs: remove from other groups' totals/challenges, then delete with photos.
  const runs = await Run.find({ user: userId }).select('_id distanceMetres photo').lean();
  for (const run of runs) {
    await revokeGroupRunContributions(run).catch((e) => log('revoke run', e));
  }
  const runIds = runs.map((r) => r._id);
  await RunComment.deleteMany({ run: { $in: runIds } });
  await Run.deleteMany({ _id: { $in: runIds } });
  await Promise.all(
    runs.filter((r) => r.photo?.path).map((r) => deleteRunPhoto(r.photo.path).catch((e) => log('run photo', e))),
  );

  // 3. Interactions on other people's content.
  const runComments = await RunComment.find({ user: userId }).select('run').lean();
  await RunComment.deleteMany({ user: userId });
  await decrementCounts(Run, 'commentCount', runComments, 'run');

  await Run.updateMany({ likes: userId }, [
    {
      $set: {
        likes: { $setDifference: ['$likes', [userId]] },
        likeCount: { $max: [0, { $subtract: [{ $ifNull: ['$likeCount', 0] }, 1] }] },
      },
    },
  ], { updatePipeline: true });

  // 4. Group content in groups the user did not create.
  const authoredPostIds = (await GroupPost.find({ author: userId }).select('_id').lean()).map((p) => p._id);
  await GroupPostComment.deleteMany({ post: { $in: authoredPostIds } });
  await GroupReport.deleteMany({ post: { $in: authoredPostIds } });
  await GroupPost.deleteMany({ _id: { $in: authoredPostIds } });

  const postComments = await GroupPostComment.find({ user: userId }).select('post').lean();
  await GroupPostComment.deleteMany({ user: userId });
  await decrementCounts(GroupPost, 'commentCount', postComments, 'post');

  await GroupPost.updateMany({ likes: userId }, [
    {
      $set: {
        likes: { $setDifference: ['$likes', [userId]] },
        likeCount: { $max: [0, { $subtract: [{ $ifNull: ['$likeCount', 0] }, 1] }] },
      },
    },
  ], { updatePipeline: true });

  const createdChallengeIds = (await GroupChallenge.find({ creator: userId }).select('_id').lean()).map((c) => c._id);
  await GroupChallengeParticipant.deleteMany({ challenge: { $in: createdChallengeIds } });
  await GroupChallenge.deleteMany({ _id: { $in: createdChallengeIds } });

  const participations = await GroupChallengeParticipant.find({ user: userId }).select('challenge').lean();
  await GroupChallengeParticipant.deleteMany({ user: userId });
  await decrementCounts(GroupChallenge, 'participantCount', participations, 'challenge');

  await GroupEvent.deleteMany({ creator: userId });
  await GroupEvent.updateMany({ participants: userId }, [
    {
      $set: {
        participants: { $setDifference: ['$participants', [userId]] },
        participantCount: { $max: [0, { $subtract: [{ $ifNull: ['$participantCount', 0] }, 1] }] },
      },
    },
  ], { updatePipeline: true });

  await GroupReport.deleteMany({ reporter: userId });
  await GroupReport.updateMany({ resolvedBy: userId }, { $set: { resolvedBy: null } });

  // 5. Memberships: leave every group and recount active members.
  const memberships = await GroupMember.find({ user: userId }).select('group').lean();
  await GroupMember.deleteMany({ user: userId });
  await GroupMember.updateMany({ invitedBy: userId }, { $set: { invitedBy: null } });
  const touchedGroupIds = [...new Set(memberships.map((m) => m.group.toString()))];
  await Promise.all(
    touchedGroupIds.map(async (groupId) => {
      const activeCount = await GroupMember.countDocuments({ group: groupId, status: 'active' });
      await Group.updateOne({ _id: groupId }, { $set: { memberCount: activeCount } });
    }),
  );

  // 6. Social graph, notifications, rewards.
  await Promise.all([
    User.updateMany({ followers: userId }, { $pull: { followers: userId } }),
    User.updateMany({ following: userId }, { $pull: { following: userId } }),
    Notification.deleteMany({ $or: [{ recipient: userId }, { sender: userId }] }),
    UserBadge.deleteMany({ user: userId }),
    UserDefi.deleteMany({ user: userId }),
  ]);

  // 7. Firebase: avatars and the Auth account (Google/Apple sign-in).
  if (firebaseApp) {
    try {
      await getStorage(firebaseApp).bucket().deleteFiles({ prefix: `avatars/${userId}_`, force: true });
    } catch (e) {
      log('avatars', e);
    }
    try {
      const fbUser = await getAuth(firebaseApp).getUserByEmail(user.email);
      await getAuth(firebaseApp).deleteUser(fbUser.uid);
    } catch (e) {
      if (e?.code !== 'auth/user-not-found') log('firebase auth', e);
    }
  }

  // 8. Finally the user document itself.
  await User.deleteOne({ _id: userId });
}

module.exports = { deleteUserAccount };
