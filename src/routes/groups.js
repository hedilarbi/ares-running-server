const express = require('express');
const mongoose = require('mongoose');
const Group = require('../models/Group');
const GroupMember = require('../models/GroupMember');
const GroupRunContribution = require('../models/GroupRunContribution');
const GroupPost = require('../models/GroupPost');
const GroupPostComment = require('../models/GroupPostComment');
const GroupChallenge = require('../models/GroupChallenge');
const GroupChallengeParticipant = require('../models/GroupChallengeParticipant');
const GroupReport = require('../models/GroupReport');
const Run = require('../models/Run');
const User = require('../models/User');
const { sendNotifications } = require('../services/notificationService');
const { authenticateToken } = require('../middleware/auth');
const { getPeriodId } = require('../utils/time');

const router = express.Router();

const isValidId = (id) => mongoose.isObjectIdOrHexString(id);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPeriodFieldAndValue(period = 'week', now = new Date()) {
  if (period === 'month' || period === 'mensuel') {
    return {
      field: 'monthPeriodId',
      value: getPeriodId(now, 'mensuel'),
      label: 'month',
    };
  }
  return {
    field: 'weekPeriodId',
    value: getPeriodId(now, 'hebdomadaire'),
    label: 'week',
  };
}

/**
 * Computes inter-group rankings for a given geographic filter and time period.
 * Supports metric = 'total' (cumulative distance) or 'average' (km per active member).
 */
async function computeInterGroupRankings({
  geoMatch = {},
  period = 'week',
  metric = 'total',
  now = new Date(),
}) {
  const { field, value } = getPeriodFieldAndValue(period, now);

  const groups = await Group.find({ isActive: true, ...geoMatch })
    .select('_id name photo type city governorate country privacy memberCount totalDistanceMetres')
    .lean();

  if (groups.length === 0) return [];

  const groupIds = groups.map((g) => g._id);

  const contribStats = await GroupRunContribution.aggregate([
    {
      $match: {
        group: { $in: groupIds },
        [field]: value,
      },
    },
    {
      $group: {
        _id: '$group',
        periodDistanceMetres: { $sum: '$distanceMetres' },
        periodRunsCount: { $sum: 1 },
        activeUsers: { $addToSet: '$user' },
      },
    },
    {
      $project: {
        _id: 1,
        periodDistanceMetres: 1,
        periodRunsCount: 1,
        activeMemberCount: { $size: '$activeUsers' },
      },
    },
  ]);

  const statsByGroupId = new Map(
    contribStats.map((row) => [row._id.toString(), row]),
  );

  const enriched = groups.map((g) => {
    const st = statsByGroupId.get(g._id.toString());
    const distanceMetres = st ? st.periodDistanceMetres : 0;
    const activeMemberCount = st ? st.activeMemberCount : 0;
    const runsCount = st ? st.periodRunsCount : 0;
    const averageDistanceMetres =
      activeMemberCount > 0 ? Math.round(distanceMetres / activeMemberCount) : 0;

    return {
      id: g._id.toString(),
      name: g.name,
      photo: g.photo || null,
      type: g.type,
      city: g.city,
      governorate: g.governorate,
      country: g.country || 'Tunisie',
      privacy: g.privacy,
      memberCount: g.memberCount || 1,
      activeMemberCount,
      distanceMetres,
      averageDistanceMetres,
      runsCount,
      totalDistanceMetres: g.totalDistanceMetres || 0,
    };
  });

  enriched.sort((a, b) => {
    if (metric === 'average') {
      if (b.averageDistanceMetres !== a.averageDistanceMetres) {
        return b.averageDistanceMetres - a.averageDistanceMetres;
      }
    }
    if (b.distanceMetres !== a.distanceMetres) {
      return b.distanceMetres - a.distanceMetres;
    }
    return b.totalDistanceMetres - a.totalDistanceMetres;
  });

  return enriched.map((item, idx) => ({
    ...item,
    rank: idx + 1,
  }));
}

/**
 * Computes a single group's rank in its city, governorate, and country for the given period.
 */
async function getGroupGeographicRanks(group, period = 'week', metric = 'total') {
  const [cityList, govList, countryList] = await Promise.all([
    group.city
      ? computeInterGroupRankings({ geoMatch: { city: group.city }, period, metric })
      : Promise.resolve([]),
    group.governorate
      ? computeInterGroupRankings({ geoMatch: { governorate: group.governorate }, period, metric })
      : Promise.resolve([]),
    computeInterGroupRankings({
      geoMatch: { country: group.country || 'Tunisie' },
      period,
      metric,
    }),
  ]);

  const targetId = group._id.toString();
  const cityEntry = cityList.find((g) => g.id === targetId);
  const govEntry = govList.find((g) => g.id === targetId);
  const countryEntry = countryList.find((g) => g.id === targetId);

  return {
    city: {
      rank: cityEntry?.rank ?? null,
      total: cityList.length,
      name: group.city,
    },
    governorate: {
      rank: govEntry?.rank ?? null,
      total: govList.length,
      name: group.governorate,
    },
    country: {
      rank: countryEntry?.rank ?? null,
      total: countryList.length,
      name: group.country || 'Tunisie',
    },
    periodDistanceMetres: countryEntry?.distanceMetres ?? 0,
    averageDistanceMetres: countryEntry?.averageDistanceMetres ?? 0,
    activeMemberCount: countryEntry?.activeMemberCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 1. LIST & SEARCH GROUPS — GET /api/groups
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.userDB._id;
    const { q, city, governorate, type, filter } = req.query;

    // Fetch all memberships for the current user so we can annotate each group
    const myMemberships = await GroupMember.find({ user: userId }).lean();
    const membershipByGroupId = new Map(
      myMemberships.map((m) => [m.group.toString(), m]),
    );

    const query = { isActive: true };

    if (filter === 'mine') {
      const myGroupIds = myMemberships
        .filter((m) => m.status === 'active' || m.status === 'invited' || m.status === 'pending_request')
        .map((m) => m.group);
      query._id = { $in: myGroupIds };
    } else {
      // Both public and private groups are visible in discovery/search so users can
      // request to join a private group, while private content remains restricted.
      if (type && ['club', 'amis'].includes(String(type))) {
        query.type = String(type);
      }
      if (city && typeof city === 'string' && city.trim()) {
        query.city = new RegExp(`^${escapeRegex(city.trim())}$`, 'i');
      }
      if (governorate && typeof governorate === 'string' && governorate.trim()) {
        query.governorate = new RegExp(`^${escapeRegex(governorate.trim())}$`, 'i');
      }
      if (q && typeof q === 'string' && q.trim()) {
        const regex = new RegExp(escapeRegex(q.trim().slice(0, 64)), 'i');
        query.$or = [
          { name: regex },
          { city: regex },
          { governorate: regex },
          { description: regex },
        ];
      }
    }

    const groups = await Group.find(query)
      .sort({ totalDistanceMetres: -1, memberCount: -1, createdAt: -1 })
      .limit(50)
      .lean();

    const serialized = groups.map((g) => {
      const m = membershipByGroupId.get(g._id.toString());
      return {
        id: g._id.toString(),
        name: g.name,
        description: g.description || '',
        photo: g.photo || null,
        type: g.type,
        city: g.city,
        governorate: g.governorate,
        country: g.country || 'Tunisie',
        privacy: g.privacy,
        memberCount: g.memberCount || 1,
        totalDistanceMetres: g.totalDistanceMetres || 0,
        totalRunsCount: g.totalRunsCount || 0,
        creatorId: g.creator.toString(),
        myStatus: m ? m.status : null,
        myRole: m ? m.role : null,
        autoContributeKm: m ? m.autoContributeKm : true,
        createdAt: g.createdAt,
      };
    });

    return res.status(200).json({ groups: serialized });
  } catch (error) {
    console.error('Erreur GET /api/groups:', error);
    return res.status(500).json({ error: 'Erreur lors de la récupération des groupes.' });
  }
});

// ---------------------------------------------------------------------------
// 2. INTER-GROUP RANKINGS — GET /api/groups/rankings
// ---------------------------------------------------------------------------
router.get('/rankings', authenticateToken, async (req, res) => {
  try {
    const scope = ['city', 'governorate', 'country'].includes(String(req.query.scope))
      ? String(req.query.scope)
      : 'city';
    const period = req.query.period === 'month' ? 'month' : 'week';
    const metric = req.query.metric === 'average' ? 'average' : 'total';

    const currentUser = req.userDB;
    const geoMatch = {};

    if (scope === 'city') {
      const targetCity =
        typeof req.query.city === 'string' && req.query.city.trim()
          ? req.query.city.trim()
          : currentUser.city;
      if (!targetCity) {
        return res.status(200).json({ rankings: [], myGroupsRanks: [], scopeLabel: 'Votre ville' });
      }
      geoMatch.city = new RegExp(`^${escapeRegex(targetCity)}$`, 'i');
    } else if (scope === 'governorate') {
      const targetGov =
        typeof req.query.governorate === 'string' && req.query.governorate.trim()
          ? req.query.governorate.trim()
          : currentUser.governorate;
      if (!targetGov) {
        return res.status(200).json({
          rankings: [],
          myGroupsRanks: [],
          scopeLabel: 'Votre gouvernorat',
        });
      }
      geoMatch.governorate = new RegExp(`^${escapeRegex(targetGov)}$`, 'i');
    } else {
      geoMatch.country = currentUser.country || 'Tunisie';
    }

    const rankings = await computeInterGroupRankings({ geoMatch, period, metric });

    const myMemberships = await GroupMember.find({
      user: currentUser._id,
      status: 'active',
    })
      .select('group')
      .lean();
    const myGroupIdSet = new Set(myMemberships.map((m) => m.group.toString()));

    const annotatedRankings = rankings.map((r) => ({
      ...r,
      isMyGroup: myGroupIdSet.has(r.id),
    }));

    const myGroupsRanks = annotatedRankings.filter((r) => r.isMyGroup);

    return res.status(200).json({
      rankings: annotatedRankings,
      myGroupsRanks,
      period,
      metric,
      scope,
    });
  } catch (error) {
    console.error('Erreur GET /api/groups/rankings:', error);
    return res.status(500).json({ error: 'Erreur lors du calcul du classement des groupes.' });
  }
});

// ---------------------------------------------------------------------------
// 3. CREATE A GROUP — POST /api/groups
// ---------------------------------------------------------------------------
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, photo, type, city, governorate, privacy } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Le nom du groupe est requis.' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Le nom du groupe ne doit pas dépasser 100 caractères.' });
    }
    if (!['club', 'amis'].includes(type)) {
      return res.status(400).json({
        error: "Le type de groupe doit être 'club' (Club de running) ou 'amis' (Groupe d'amis).",
      });
    }
    const cleanCity = typeof city === 'string' ? city.trim() : '';
    const cleanGovernorate = typeof governorate === 'string' ? governorate.trim() : '';
    const groupPrivacy = privacy === 'private' ? 'private' : 'public';

    const group = await Group.create({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim().slice(0, 500) : '',
      photo: typeof photo === 'string' ? photo : '',
      type,
      city: cleanCity,
      governorate: cleanGovernorate,
      country: req.userDB.country || 'Tunisie',
      privacy: groupPrivacy,
      creator: req.userDB._id,
      memberCount: 1,
      totalDistanceMetres: 0,
      totalRunsCount: 0,
    });

    // Creator automatically becomes administrator of the group
    await GroupMember.create({
      group: group._id,
      user: req.userDB._id,
      role: 'admin',
      status: 'active',
      autoContributeKm: true,
      joinedAt: new Date(),
    });

    return res.status(201).json({
      group: {
        id: group._id.toString(),
        name: group.name,
        description: group.description,
        photo: group.photo || null,
        type: group.type,
        city: group.city,
        governorate: group.governorate,
        country: group.country,
        privacy: group.privacy,
        memberCount: 1,
        totalDistanceMetres: 0,
        creatorId: req.userDB._id.toString(),
        myStatus: 'active',
        myRole: 'admin',
        autoContributeKm: true,
      },
    });
  } catch (error) {
    console.error('Erreur POST /api/groups:', error);
    return res.status(500).json({ error: 'Erreur lors de la création du groupe.' });
  }
});

// ---------------------------------------------------------------------------
// 4. SHARE A RUN TO ONE OR MORE GROUPS — POST /api/groups/share-run
// ---------------------------------------------------------------------------
router.post('/share-run', authenticateToken, async (req, res) => {
  try {
    const { runId, groupIds, caption, photoUrl } = req.body || {};

    if (!isValidId(runId)) {
      return res.status(400).json({ error: 'Identifiant de course invalide.' });
    }
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({ error: 'Sélectionnez au moins un groupe.' });
    }

    const validGroupIds = groupIds.filter(isValidId);
    if (validGroupIds.length === 0) {
      return res.status(400).json({ error: 'Groupes sélectionnés invalides.' });
    }

    const run = await Run.findOne({ _id: runId, user: req.userDB._id })
      .select('_id user distanceMetres durationSeconds averagePaceSecondsPerKm startedAt photo description')
      .lean();
    if (!run) {
      return res.status(404).json({ error: 'Course introuvable ou vous n’en êtes pas l’auteur.' });
    }

    // Verify caller is an active member of each selected group
    const memberships = await GroupMember.find({
      user: req.userDB._id,
      group: { $in: validGroupIds },
      status: 'active',
    })
      .select('group')
      .lean();

    const allowedGroupIds = memberships.map((m) => m.group);
    if (allowedGroupIds.length === 0) {
      return res.status(403).json({ error: 'Vous devez être membre actif du groupe pour publier.' });
    }

    const cleanCaption =
      typeof caption === 'string'
        ? caption.trim().slice(0, 500)
        : run.description || '';
    const finalPhotoUrl =
      typeof photoUrl === 'string' && photoUrl.trim()
        ? photoUrl.trim()
        : run.photo?.url || '';

    const sharedGroupIds = [];
    for (const gId of allowedGroupIds) {
      await GroupPost.findOneAndUpdate(
        { group: gId, run: run._id },
        {
          $setOnInsert: {
            group: gId,
            author: req.userDB._id,
            run: run._id,
            showRoute: false,
          },
          $set: {
            caption: cleanCaption,
            photoUrl: finalPhotoUrl,
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
      sharedGroupIds.push(gId.toString());
    }

    return res.status(201).json({
      shared: true,
      sharedGroupIds,
    });
  } catch (error) {
    console.error('Erreur POST /api/groups/share-run:', error);
    return res.status(500).json({ error: 'Erreur lors du partage de la course.' });
  }
});

// ---------------------------------------------------------------------------
// 5. GET GROUP DETAILS — GET /api/groups/:id
// ---------------------------------------------------------------------------
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true })
      .populate('creator', 'name pseudo photo')
      .lean();
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    const period = req.query.period === 'month' ? 'month' : 'week';
    const metric = req.query.metric === 'average' ? 'average' : 'total';

    const [myMembership, activeMemberCount, pendingCount, ranks] = await Promise.all([
      GroupMember.findOne({ group: group._id, user: req.userDB._id }).lean(),
      GroupMember.countDocuments({ group: group._id, status: 'active' }),
      GroupMember.countDocuments({ group: group._id, status: 'pending_request' }),
      getGroupGeographicRanks(group, period, metric),
    ]);

    const isAdmin =
      group.creator._id.equals(req.userDB._id) || myMembership?.role === 'admin';
    const isMember = myMembership?.status === 'active';
    const canViewContent = group.privacy === 'public' || isMember || isAdmin;

    // Sync memberCount if drifted
    if (group.memberCount !== activeMemberCount) {
      await Group.updateOne({ _id: group._id }, { $set: { memberCount: activeMemberCount } });
    }

    return res.status(200).json({
      group: {
        id: group._id.toString(),
        name: group.name,
        description: group.description || '',
        photo: group.photo || null,
        type: group.type,
        city: group.city,
        governorate: group.governorate,
        country: group.country || 'Tunisie',
        privacy: group.privacy,
        memberCount: activeMemberCount,
        totalDistanceMetres: group.totalDistanceMetres || 0,
        totalRunsCount: group.totalRunsCount || 0,
        creator: group.creator
          ? {
              id: group.creator._id.toString(),
              name: group.creator.name || group.creator.pseudo || 'Créateur',
              photo: group.creator.photo || null,
            }
          : null,
        myStatus: myMembership?.status || null,
        myRole: myMembership?.role || null,
        autoContributeKm: myMembership?.autoContributeKm ?? true,
        isAdmin,
        canViewContent,
        pendingRequestsCount: isAdmin ? pendingCount : 0,
        ranks,
        createdAt: group.createdAt,
      },
    });
  } catch (error) {
    console.error('Erreur GET /api/groups/:id:', error);
    return res.status(500).json({ error: 'Erreur lors du chargement du groupe.' });
  }
});

// ---------------------------------------------------------------------------
// 6. UPDATE GROUP — PUT /api/groups/:id (Creator / Admin only)
// ---------------------------------------------------------------------------
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true });
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    if (!group.creator.equals(req.userDB._id)) {
      return res.status(403).json({ error: "Seul l'administrateur du groupe peut le modifier." });
    }

    const { name, description, photo, type, city, governorate, privacy } = req.body || {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Le nom du groupe est requis.' });
      }
      group.name = name.trim().slice(0, 100);
    }
    if (description !== undefined && typeof description === 'string') {
      group.description = description.trim().slice(0, 500);
    }
    if (photo !== undefined && typeof photo === 'string') {
      group.photo = photo;
    }
    if (type !== undefined && ['club', 'amis'].includes(type)) {
      group.type = type;
    }
    if (city !== undefined && typeof city === 'string') {
      group.city = city.trim();
    }
    if (governorate !== undefined && typeof governorate === 'string') {
      group.governorate = governorate.trim();
    }
    if (privacy !== undefined && ['public', 'private'].includes(privacy)) {
      group.privacy = privacy;
    }

    await group.save();
    return res.status(200).json({ group });
  } catch (error) {
    console.error('Erreur PUT /api/groups/:id:', error);
    return res.status(500).json({ error: 'Erreur lors de la modification du groupe.' });
  }
});

// ---------------------------------------------------------------------------
// 7. DELETE GROUP — DELETE /api/groups/:id (Creator only)
// ---------------------------------------------------------------------------
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    if (!group.creator.equals(req.userDB._id) && req.userDB.role !== 'admin') {
      return res.status(403).json({ error: "Seul l'administrateur peut supprimer ce groupe." });
    }

    await Promise.all([
      GroupMember.deleteMany({ group: group._id }),
      GroupRunContribution.deleteMany({ group: group._id }),
      GroupPostComment.deleteMany({ group: group._id }),
      GroupPost.deleteMany({ group: group._id }),
      GroupChallengeParticipant.deleteMany({ group: group._id }),
      GroupChallenge.deleteMany({ group: group._id }),
      GroupReport.deleteMany({ group: group._id }),
      Group.deleteOne({ _id: group._id }),
    ]);

    return res.status(200).json({ deleted: true });
  } catch (error) {
    console.error('Erreur DELETE /api/groups/:id:', error);
    return res.status(500).json({ error: 'Erreur lors de la suppression du groupe.' });
  }
});

// ---------------------------------------------------------------------------
// 8. JOIN / LEAVE / INVITE / MANAGE MEMBERS
// ---------------------------------------------------------------------------
router.post('/:id/join', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true });
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    const existing = await GroupMember.findOne({
      group: group._id,
      user: req.userDB._id,
    });

    if (existing) {
      if (existing.status === 'active') {
        return res.status(200).json({ status: 'active', memberCount: group.memberCount });
      }
      if (existing.status === 'invited' || group.privacy === 'public') {
        existing.status = 'active';
        existing.joinedAt = new Date();
        await existing.save();
        const activeCount = await GroupMember.countDocuments({ group: group._id, status: 'active' });
        await Group.updateOne({ _id: group._id }, { $set: { memberCount: activeCount } });
        return res.status(200).json({ status: 'active', memberCount: activeCount });
      }
      return res.status(200).json({ status: existing.status, memberCount: group.memberCount });
    }

    const nextStatus = group.privacy === 'private' ? 'pending_request' : 'active';
    await GroupMember.create({
      group: group._id,
      user: req.userDB._id,
      role: 'member',
      status: nextStatus,
      autoContributeKm: true,
      joinedAt: new Date(),
    });

    const activeCount = await GroupMember.countDocuments({ group: group._id, status: 'active' });
    await Group.updateOne({ _id: group._id }, { $set: { memberCount: activeCount } });

    // If joining a private group, notify the group creator about the pending request
    if (nextStatus === 'pending_request' && !group.creator.equals(req.userDB._id)) {
      sendNotifications([
        {
          recipient: group.creator,
          sender: req.userDB._id,
          type: 'group_join_requested',
          title: `Demande d'adhésion : ${group.name}`,
          body: `${req.userDB.name || req.userDB.pseudo || 'Un coureur'} souhaite rejoindre votre groupe.`,
          data: {
            groupId: group._id.toString(),
            url: `/groups/${group._id.toString()}`,
          },
        },
      ]).catch((err) => console.error('Erreur notif group_join_requested:', err));
    }

    return res.status(200).json({ status: nextStatus, memberCount: activeCount });
  } catch (error) {
    console.error('Erreur POST /api/groups/:id/join:', error);
    return res.status(500).json({ error: "Erreur lors de la demande d'adhésion." });
  }
});

router.post('/:id/leave', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    if (group.creator.equals(req.userDB._id)) {
      return res.status(400).json({
        error: 'En tant que créateur du groupe, vous ne pouvez pas le quitter sans le supprimer.',
      });
    }

    await GroupMember.deleteOne({ group: group._id, user: req.userDB._id });
    const activeCount = await GroupMember.countDocuments({ group: group._id, status: 'active' });
    await Group.updateOne({ _id: group._id }, { $set: { memberCount: activeCount } });

    return res.status(200).json({ left: true, memberCount: activeCount });
  } catch (error) {
    console.error('Erreur POST /api/groups/:id/leave:', error);
    return res.status(500).json({ error: 'Erreur lors de la sortie du groupe.' });
  }
});

router.post('/:id/invite', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }
    const { userId } = req.body || {};
    if (!isValidId(userId)) {
      return res.status(400).json({ error: 'Identifiant utilisateur invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true });
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }
    if (!group.creator.equals(req.userDB._id)) {
      return res.status(403).json({ error: 'Seul le créateur du groupe peut inviter des membres.' });
    }

    const targetUser = await User.findById(userId).select('_id');
    if (!targetUser) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const existing = await GroupMember.findOne({ group: group._id, user: userId });
    if (existing) {
      if (existing.status === 'pending_request') {
        existing.status = 'active';
        existing.joinedAt = new Date();
        await existing.save();
        const activeCount = await GroupMember.countDocuments({ group: group._id, status: 'active' });
        await Group.updateOne({ _id: group._id }, { $set: { memberCount: activeCount } });
        return res.status(200).json({ status: 'active' });
      }
      return res.status(200).json({ status: existing.status });
    }

    await GroupMember.create({
      group: group._id,
      user: userId,
      role: 'member',
      status: 'invited',
      invitedBy: req.userDB._id,
      autoContributeKm: true,
    });

    // Notify the invited runner
    sendNotifications([
      {
        recipient: userId,
        sender: req.userDB._id,
        type: 'group_invitation',
        title: `Invitation au groupe ${group.name}`,
        body: `${req.userDB.name || req.userDB.pseudo || "L'administrateur"} vous a invité à rejoindre son groupe.`,
        data: {
          groupId: group._id.toString(),
          url: `/groups/${group._id.toString()}`,
        },
      },
    ]).catch((err) => console.error('Erreur notif group_invitation:', err));

    return res.status(201).json({ status: 'invited' });
  } catch (error) {
    console.error('Erreur POST /api/groups/:id/invite:', error);
    return res.status(500).json({ error: "Erreur lors de l'invitation." });
  }
});

router.get('/:id/members', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true }).lean();
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    const myMembership = await GroupMember.findOne({
      group: group._id,
      user: req.userDB._id,
    }).lean();
    const isAdmin = group.creator.equals(req.userDB._id) || myMembership?.role === 'admin';
    const isMember = myMembership?.status === 'active';

    if (group.privacy === 'private' && !isMember && !isAdmin) {
      return res.status(403).json({
        error: 'Les membres de ce groupe privé ne sont visibles que par ses membres.',
      });
    }

    const rows = await GroupMember.find({ group: group._id })
      .populate('user', 'name pseudo photo city governorate level xp')
      .sort({ role: 1, joinedAt: 1 })
      .lean();

    const serializeMember = (row) => ({
      id: row.user._id.toString(),
      name: row.user.name || row.user.pseudo || 'Coureur',
      pseudo: row.user.pseudo || '',
      photo: row.user.photo || null,
      city: row.user.city || '',
      governorate: row.user.governorate || '',
      level: row.user.level || 'Débutant',
      role: row.role,
      status: row.status,
      joinedAt: row.joinedAt,
    });

    const validRows = rows.filter((r) => r.user);
    const members = validRows.filter((r) => r.status === 'active').map(serializeMember);
    const pendingRequests = isAdmin
      ? validRows.filter((r) => r.status === 'pending_request').map(serializeMember)
      : [];
    const invited = isAdmin
      ? validRows.filter((r) => r.status === 'invited').map(serializeMember)
      : [];

    return res.status(200).json({ members, pendingRequests, invited });
  } catch (error) {
    console.error('Erreur GET /api/groups/:id/members:', error);
    return res.status(500).json({ error: 'Erreur lors du chargement des membres.' });
  }
});

router.patch('/:id/members/:userId', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.userId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true });
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    if (!group.creator.equals(req.userDB._id)) {
      return res.status(403).json({ error: 'Seul le créateur du groupe peut gérer les membres.' });
    }

    const { action } = req.body || {}; // 'accept' | 'reject' | 'remove'
    if (!['accept', 'reject', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'Action invalide.' });
    }

    if (action === 'accept') {
      const member = await GroupMember.findOneAndUpdate(
        { group: group._id, user: req.params.userId },
        { $set: { status: 'active', joinedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!member) {
        return res.status(404).json({ error: 'Demande introuvable.' });
      }

      // Notify the accepted member
      sendNotifications([
        {
          recipient: req.params.userId,
          sender: req.userDB._id,
          type: 'group_join_accepted',
          title: `Bienvenue dans ${group.name} !`,
          body: `Votre demande d'adhésion a été acceptée par l'administrateur. Vos courses comptent désormais pour le groupe.`,
          data: {
            groupId: group._id.toString(),
            url: `/groups/${group._id.toString()}`,
          },
        },
      ]).catch((err) => console.error('Erreur notif group_join_accepted:', err));
    } else {
      if (group.creator.equals(req.params.userId)) {
        return res.status(400).json({ error: 'Le créateur ne peut pas se retirer lui-même.' });
      }
      await GroupMember.deleteOne({ group: group._id, user: req.params.userId });
    }

    const activeCount = await GroupMember.countDocuments({ group: group._id, status: 'active' });
    await Group.updateOne({ _id: group._id }, { $set: { memberCount: activeCount } });

    return res.status(200).json({ ok: true, memberCount: activeCount });
  } catch (error) {
    console.error('Erreur PATCH /api/groups/:id/members/:userId:', error);
    return res.status(500).json({ error: 'Erreur lors de la gestion du membre.' });
  }
});

router.patch('/:id/my-settings', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const autoContributeKm = Boolean(req.body?.autoContributeKm);
    const updated = await GroupMember.findOneAndUpdate(
      { group: req.params.id, user: req.userDB._id, status: 'active' },
      { $set: { autoContributeKm } },
      { returnDocument: 'after' },
    );

    if (!updated) {
      return res.status(404).json({ error: "Vous n'êtes pas membre actif de ce groupe." });
    }

    return res.status(200).json({ autoContributeKm: updated.autoContributeKm });
  } catch (error) {
    console.error('Erreur PATCH /api/groups/:id/my-settings:', error);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour des préférences.' });
  }
});

// ---------------------------------------------------------------------------
// 9. INTERNAL GROUP LEADERBOARD — GET /api/groups/:id/leaderboard
//    Metrics: 'distance' | 'runs' | 'regularity'
//    Period:  'week' | 'month'
// ---------------------------------------------------------------------------
router.get('/:id/leaderboard', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true }).lean();
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    const myMembership = await GroupMember.findOne({
      group: group._id,
      user: req.userDB._id,
      status: 'active',
    }).lean();

    if (group.privacy === 'private' && !myMembership && !group.creator.equals(req.userDB._id)) {
      return res.status(403).json({
        error: 'Ce classement est réservé aux membres du groupe privé.',
      });
    }

    const period = req.query.period === 'month' ? 'month' : 'week';
    const metric = ['distance', 'runs', 'regularity'].includes(String(req.query.metric))
      ? String(req.query.metric)
      : 'distance';
    const { field, value } = getPeriodFieldAndValue(period);

    const [activeMembers, contribRows] = await Promise.all([
      GroupMember.find({ group: group._id, status: 'active' })
        .populate('user', 'name pseudo photo level')
        .lean(),
      GroupRunContribution.aggregate([
        {
          $match: {
            group: group._id,
            [field]: value,
          },
        },
        {
          $group: {
            _id: '$user',
            distanceMetres: { $sum: '$distanceMetres' },
            runsCount: { $sum: 1 },
            activeDaysSet: { $addToSet: '$localDay' },
          },
        },
        {
          $project: {
            _id: 1,
            distanceMetres: 1,
            runsCount: 1,
            regularityDays: { $size: '$activeDaysSet' },
          },
        },
      ]),
    ]);

    const statsByUserId = new Map(
      contribRows.map((r) => [r._id.toString(), r]),
    );

    const entries = activeMembers
      .filter((m) => m.user)
      .map((m) => {
        const uid = m.user._id.toString();
        const st = statsByUserId.get(uid);
        return {
          userId: uid,
          name: m.user.name || m.user.pseudo || 'Coureur',
          pseudo: m.user.pseudo || '',
          photo: m.user.photo || null,
          role: m.role,
          distanceMetres: st?.distanceMetres || 0,
          runsCount: st?.runsCount || 0,
          regularityDays: st?.regularityDays || 0,
          isMe: uid === req.userDB._id.toString(),
        };
      });

    entries.sort((a, b) => {
      if (metric === 'runs' && b.runsCount !== a.runsCount) {
        return b.runsCount - a.runsCount;
      }
      if (metric === 'regularity' && b.regularityDays !== a.regularityDays) {
        return b.regularityDays - a.regularityDays;
      }
      if (b.distanceMetres !== a.distanceMetres) {
        return b.distanceMetres - a.distanceMetres;
      }
      return b.runsCount - a.runsCount;
    });

    const leaderboard = entries.map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
    }));

    return res.status(200).json({
      leaderboard,
      period,
      metric,
    });
  } catch (error) {
    console.error('Erreur GET /api/groups/:id/leaderboard:', error);
    return res.status(500).json({ error: 'Erreur lors du calcul du classement interne.' });
  }
});

// ---------------------------------------------------------------------------
// 10. GROUP FEED & VOLUNTARY RUN SHARING
// ---------------------------------------------------------------------------
router.get('/:id/feed', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true }).lean();
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    const myMembership = await GroupMember.findOne({
      group: group._id,
      user: req.userDB._id,
      status: 'active',
    }).lean();

    if (group.privacy === 'private' && !myMembership && !group.creator.equals(req.userDB._id)) {
      return res.status(403).json({
        error: 'Les publications de ce groupe privé sont réservées à ses membres.',
      });
    }

    const posts = await GroupPost.find({ group: group._id })
      .sort({ createdAt: -1 })
      .limit(30)
      // Explicitly omit routePoints so detailed GPS route remains hidden by default
      .populate(
        'run',
        '_id startedAt finishedAt durationSeconds distanceMetres averagePaceSecondsPerKm caloriesKcal photo.url description',
      )
      .populate('author', 'name pseudo photo city')
      .lean();

    const isAdmin = group.creator.equals(req.userDB._id) || myMembership?.role === 'admin';
    const myIdStr = req.userDB._id.toString();

    const items = posts
      .filter((p) => p.run && p.author)
      .map((p) => ({
        id: p._id.toString(),
        groupId: group._id.toString(),
        caption: p.caption || '',
        photoUrl: p.photoUrl || p.run.photo?.url || null,
        createdAt: p.createdAt,
        likeCount: p.likeCount || 0,
        likedByMe: (p.likes || []).some((id) => id.toString() === myIdStr),
        commentCount: p.commentCount || 0,
        canDelete: p.author._id.toString() === myIdStr || isAdmin,
        author: {
          id: p.author._id.toString(),
          name: p.author.name || p.author.pseudo || 'Coureur',
          pseudo: p.author.pseudo || '',
          photo: p.author.photo || null,
          city: p.author.city || '',
        },
        run: {
          id: p.run._id.toString(),
          startedAt: p.run.startedAt,
          distanceMetres: p.run.distanceMetres,
          durationSeconds: p.run.durationSeconds,
          averagePaceSecondsPerKm: p.run.averagePaceSecondsPerKm,
          caloriesKcal: p.run.caloriesKcal,
        },
      }));

    return res.status(200).json({ items });
  } catch (error) {
    console.error('Erreur GET /api/groups/:id/feed:', error);
    return res.status(500).json({ error: 'Erreur lors du chargement du fil du groupe.' });
  }
});

router.post('/:id/posts', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const { runId, caption, photoUrl } = req.body || {};
    if (!isValidId(runId)) {
      return res.status(400).json({ error: 'Identifiant de course invalide.' });
    }

    const [group, membership, run] = await Promise.all([
      Group.findOne({ _id: req.params.id, isActive: true }).lean(),
      GroupMember.findOne({
        group: req.params.id,
        user: req.userDB._id,
        status: 'active',
      }).lean(),
      Run.findOne({ _id: runId, user: req.userDB._id })
        .select('_id startedAt durationSeconds distanceMetres averagePaceSecondsPerKm caloriesKcal photo description')
        .lean(),
    ]);

    if (!group) return res.status(404).json({ error: 'Groupe introuvable.' });
    if (!membership) {
      return res.status(403).json({ error: 'Vous devez être membre du groupe pour partager une course.' });
    }
    if (!run) {
      return res.status(404).json({ error: 'Course introuvable.' });
    }

    const post = await GroupPost.findOneAndUpdate(
      { group: group._id, run: run._id },
      {
        $setOnInsert: {
          group: group._id,
          author: req.userDB._id,
          run: run._id,
          showRoute: false,
        },
        $set: {
          caption:
            typeof caption === 'string'
              ? caption.trim().slice(0, 500)
              : run.description || '',
          photoUrl:
            typeof photoUrl === 'string' && photoUrl.trim()
              ? photoUrl.trim()
              : run.photo?.url || '',
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    return res.status(201).json({ postId: post._id.toString() });
  } catch (error) {
    console.error('Erreur POST /api/groups/:id/posts:', error);
    return res.status(500).json({ error: 'Erreur lors de la publication dans le groupe.' });
  }
});

router.delete('/:id/posts/:postId', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.postId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const [group, post] = await Promise.all([
      Group.findById(req.params.id).lean(),
      GroupPost.findOne({ _id: req.params.postId, group: req.params.id }).lean(),
    ]);

    if (!group || !post) {
      return res.status(404).json({ error: 'Publication introuvable.' });
    }

    const isAuthor = post.author.equals(req.userDB._id);
    const isGroupAdmin = group.creator.equals(req.userDB._id) || req.userDB.role === 'admin';
    if (!isAuthor && !isGroupAdmin) {
      return res.status(403).json({ error: 'Non autorisé à supprimer cette publication.' });
    }

    await Promise.all([
      GroupPostComment.deleteMany({ post: post._id }),
      GroupReport.deleteMany({ post: post._id }),
      GroupPost.deleteOne({ _id: post._id }),
    ]);

    return res.status(200).json({ deleted: true });
  } catch (error) {
    console.error('Erreur DELETE /api/groups/:id/posts/:postId:', error);
    return res.status(500).json({ error: 'Erreur lors de la suppression de la publication.' });
  }
});

router.post('/:id/posts/:postId/like', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.postId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    await GroupPost.updateOne(
      { _id: req.params.postId, group: req.params.id, likes: { $ne: req.userDB._id } },
      { $push: { likes: req.userDB._id }, $inc: { likeCount: 1 } },
    );

    const updated = await GroupPost.findById(req.params.postId).select('likeCount').lean();
    return res.status(200).json({ liked: true, likeCount: updated?.likeCount || 0 });
  } catch (error) {
    return res.status(500).json({ error: "Erreur lors de l'ajout du J'aime." });
  }
});

router.delete('/:id/posts/:postId/like', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.postId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    await GroupPost.updateOne(
      { _id: req.params.postId, group: req.params.id, likes: req.userDB._id },
      { $pull: { likes: req.userDB._id }, $inc: { likeCount: -1 } },
    );

    const updated = await GroupPost.findById(req.params.postId).select('likeCount').lean();
    return res.status(200).json({ liked: false, likeCount: Math.max(0, updated?.likeCount || 0) });
  } catch (error) {
    return res.status(500).json({ error: "Erreur lors du retrait du J'aime." });
  }
});

router.get('/:id/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.postId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const [group, post] = await Promise.all([
      Group.findById(req.params.id).lean(),
      GroupPost.findOne({ _id: req.params.postId, group: req.params.id }).lean(),
    ]);
    if (!group || !post) {
      return res.status(404).json({ error: 'Publication introuvable.' });
    }

    const comments = await GroupPostComment.find({ post: post._id })
      .sort({ _id: 1 })
      .limit(100)
      .populate('user', 'name pseudo photo')
      .lean();

    const myIdStr = req.userDB._id.toString();
    const isGroupAdmin = group.creator.equals(req.userDB._id);

    return res.status(200).json({
      comments: comments.map((c) => ({
        id: c._id.toString(),
        text: c.text,
        createdAt: c.createdAt,
        canDelete:
          (c.user && c.user._id.toString() === myIdStr) ||
          post.author.toString() === myIdStr ||
          isGroupAdmin,
        author: c.user
          ? {
              id: c.user._id.toString(),
              name: c.user.name || c.user.pseudo || 'Coureur',
              pseudo: c.user.pseudo || '',
              photo: c.user.photo || null,
            }
          : null,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur lors du chargement des commentaires.' });
  }
});

router.post('/:id/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.postId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 500) {
      return res.status(400).json({ error: 'Commentaire invalide (1 à 500 caractères).' });
    }

    const post = await GroupPost.findOne({ _id: req.params.postId, group: req.params.id });
    if (!post) {
      return res.status(404).json({ error: 'Publication introuvable.' });
    }

    const comment = await GroupPostComment.create({
      post: post._id,
      group: post.group,
      user: req.userDB._id,
      text,
    });
    await GroupPost.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } });
    await comment.populate('user', 'name pseudo photo');

    return res.status(201).json({
      comment: {
        id: comment._id.toString(),
        text: comment.text,
        createdAt: comment.createdAt,
        canDelete: true,
        author: {
          id: req.userDB._id.toString(),
          name: req.userDB.name || req.userDB.pseudo || 'Coureur',
          pseudo: req.userDB.pseudo || '',
          photo: req.userDB.photo || null,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ error: "Erreur lors de l'envoi du commentaire." });
  }
});

router.delete('/:id/posts/:postId/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    if (
      !isValidId(req.params.id) ||
      !isValidId(req.params.postId) ||
      !isValidId(req.params.commentId)
    ) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const [group, comment] = await Promise.all([
      Group.findById(req.params.id).lean(),
      GroupPostComment.findOne({ _id: req.params.commentId, post: req.params.postId }).lean(),
    ]);
    if (!group || !comment) {
      return res.status(404).json({ error: 'Commentaire introuvable.' });
    }

    if (!comment.user.equals(req.userDB._id) && !group.creator.equals(req.userDB._id)) {
      return res.status(403).json({ error: 'Non autorisé.' });
    }

    await GroupPostComment.deleteOne({ _id: comment._id });
    await GroupPost.updateOne(
      { _id: req.params.postId, commentCount: { $gt: 0 } },
      { $inc: { commentCount: -1 } },
    );

    return res.status(200).json({ deleted: true });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du commentaire.' });
  }
});

router.post('/:id/posts/:postId/report', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.postId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 500)
        : 'Publication inappropriée';

    const post = await GroupPost.findOne({ _id: req.params.postId, group: req.params.id }).lean();
    if (!post) {
      return res.status(404).json({ error: 'Publication introuvable.' });
    }

    await GroupReport.create({
      reporter: req.userDB._id,
      group: post.group,
      post: post._id,
      reason,
    });

    return res.status(201).json({ reported: true });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur lors du signalement.' });
  }
});

// ---------------------------------------------------------------------------
// 11. GROUP CHALLENGES (Défis de groupe — Section 6)
// ---------------------------------------------------------------------------
router.get('/:id/challenges', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true }).lean();
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    const myMembership = await GroupMember.findOne({
      group: group._id,
      user: req.userDB._id,
      status: 'active',
    }).lean();

    if (group.privacy === 'private' && !myMembership && !group.creator.equals(req.userDB._id)) {
      return res.status(403).json({ error: 'Accès réservé aux membres du groupe.' });
    }

    const challenges = await GroupChallenge.find({ group: group._id, isActive: true })
      .sort({ endDate: -1, createdAt: -1 })
      .lean();

    const challengeIds = challenges.map((c) => c._id);
    const myParticipations = await GroupChallengeParticipant.find({
      challenge: { $in: challengeIds },
      user: req.userDB._id,
    }).lean();
    const myPartByChallengeId = new Map(
      myParticipations.map((p) => [p.challenge.toString(), p]),
    );

    const now = new Date();
    const enCours = [];
    const termines = [];

    for (const c of challenges) {
      const myPart = myPartByChallengeId.get(c._id.toString());
      const currentProgress =
        c.mode === 'collectif'
          ? c.collectiveProgressValue || 0
          : myPart?.progressValue || 0;
      const pct =
        c.goalValue > 0 ? Math.min(100, Math.round((currentProgress / c.goalValue) * 100)) : 0;

      const isExpired = new Date(c.endDate) < now;
      const isFinished =
        isExpired ||
        (c.mode === 'collectif' && currentProgress >= c.goalValue) ||
        myPart?.status === 'termine';

      const item = {
        id: c._id.toString(),
        title: c.title,
        description: c.description || '',
        mode: c.mode,
        goalType: c.goalType,
        goalValue: c.goalValue,
        startDate: c.startDate,
        endDate: c.endDate,
        participantCount: c.participantCount || 0,
        joined: Boolean(myPart),
        myProgressValue: myPart?.progressValue || 0,
        collectiveProgressValue: c.collectiveProgressValue || 0,
        displayProgressValue: currentProgress,
        pct,
        status: isFinished ? 'termine' : 'en_cours',
      };

      if (isExpired) {
        termines.push(item);
      } else {
        enCours.push(item);
      }
    }

    return res.status(200).json({ enCours, termines });
  } catch (error) {
    console.error('Erreur GET /api/groups/:id/challenges:', error);
    return res.status(500).json({ error: 'Erreur lors du chargement des défis du groupe.' });
  }
});

router.post('/:id/challenges', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    }

    const group = await Group.findOne({ _id: req.params.id, isActive: true });
    if (!group) {
      return res.status(404).json({ error: 'Groupe introuvable.' });
    }

    if (!group.creator.equals(req.userDB._id)) {
      return res.status(403).json({
        error: 'Seul le créateur du groupe peut organiser des défis.',
      });
    }

    const { title, description, mode, goalType, goalValue, startDate, endDate } = req.body || {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Le titre du défi est requis.' });
    }
    if (!['individuel', 'collectif'].includes(mode)) {
      return res.status(400).json({ error: "Le mode doit être 'individuel' ou 'collectif'." });
    }
    if (!['distance', 'nb_courses'].includes(goalType)) {
      return res.status(400).json({ error: "Le type d'objectif doit être 'distance' ou 'nb_courses'." });
    }

    const numericGoal = Number(goalValue);
    if (!Number.isFinite(numericGoal) || numericGoal <= 0) {
      return res.status(400).json({ error: "L'objectif doit être un nombre supérieur à 0." });
    }

    const parsedStart = startDate ? new Date(startDate) : new Date();
    const parsedEnd = endDate
      ? new Date(endDate)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    if (
      Number.isNaN(parsedStart.getTime()) ||
      Number.isNaN(parsedEnd.getTime()) ||
      parsedEnd <= parsedStart
    ) {
      return res.status(400).json({
        error: 'La date de fin doit être postérieure à la date de début.',
      });
    }

    const challenge = await GroupChallenge.create({
      group: group._id,
      creator: req.userDB._id,
      title: title.trim().slice(0, 120),
      description: typeof description === 'string' ? description.trim().slice(0, 500) : '',
      mode,
      goalType,
      goalValue: numericGoal,
      startDate: parsedStart,
      endDate: parsedEnd,
      participantCount: 1,
    });

    // Auto-enroll the creator
    await GroupChallengeParticipant.create({
      challenge: challenge._id,
      group: group._id,
      user: req.userDB._id,
      progressValue: 0,
      status: 'en_cours',
      joinedAt: new Date(),
    });

    // Notify all active group members (except the creator who just created it)
    try {
      const activeMembers = await GroupMember.find({
        group: group._id,
        status: 'active',
        user: { $ne: req.userDB._id },
      }).select('user').lean();

      if (activeMembers.length > 0) {
        const notifs = activeMembers.map((m) => ({
          recipient: m.user,
          sender: req.userDB._id,
          type: 'group_challenge_created',
          title: `Nouveau défi dans ${group.name} !`,
          body: `${req.userDB.name || req.userDB.pseudo || "L'admin"} a lancé le défi « ${challenge.title} ». Rejoins-le dès maintenant !`,
          data: {
            groupId: group._id.toString(),
            challengeId: challenge._id.toString(),
            url: `/groups/${group._id.toString()}`,
          },
        }));

        // Run asynchronously without blocking response
        sendNotifications(notifs).catch((err) =>
          console.error('Erreur sendNotifications group challenge:', err)
        );
      }
    } catch (notifErr) {
      console.warn('Erreur préparation notifications défi de groupe:', notifErr.message);
    }

    return res.status(201).json({ challenge });
  } catch (error) {
    console.error('Erreur POST /api/groups/:id/challenges:', error);
    return res.status(500).json({ error: 'Erreur lors de la création du défi.' });
  }
});

router.post('/:id/challenges/:challengeId/join', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.challengeId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const [membership, challenge] = await Promise.all([
      GroupMember.findOne({
        group: req.params.id,
        user: req.userDB._id,
        status: 'active',
      }).lean(),
      GroupChallenge.findOne({
        _id: req.params.challengeId,
        group: req.params.id,
        isActive: true,
      }),
    ]);

    if (!membership) {
      return res.status(403).json({
        error: 'Vous devez être membre actif du groupe pour rejoindre ce défi.',
      });
    }
    if (!challenge) {
      return res.status(404).json({ error: 'Défi introuvable.' });
    }
    if (new Date(challenge.endDate) < new Date()) {
      return res.status(400).json({ error: 'Ce défi est terminé.' });
    }

    const existing = await GroupChallengeParticipant.findOne({
      challenge: challenge._id,
      user: req.userDB._id,
    });

    if (!existing) {
      await GroupChallengeParticipant.create({
        challenge: challenge._id,
        group: challenge.group,
        user: req.userDB._id,
        progressValue: 0,
        status: 'en_cours',
        joinedAt: new Date(),
      });
      const count = await GroupChallengeParticipant.countDocuments({ challenge: challenge._id });
      await GroupChallenge.updateOne({ _id: challenge._id }, { $set: { participantCount: count } });
    }

    return res.status(200).json({ joined: true });
  } catch (error) {
    console.error('Erreur join group challenge:', error);
    return res.status(500).json({ error: "Erreur lors de l'inscription au défi." });
  }
});

router.delete('/:id/challenges/:challengeId', authenticateToken, async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.challengeId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }

    const group = await Group.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ error: 'Groupe introuvable.' });
    if (!group.creator.equals(req.userDB._id) && req.userDB.role !== 'admin') {
      return res.status(403).json({ error: 'Non autorisé.' });
    }

    await Promise.all([
      GroupChallengeParticipant.deleteMany({ challenge: req.params.challengeId }),
      GroupChallenge.deleteOne({ _id: req.params.challengeId, group: group._id }),
    ]);

    return res.status(200).json({ deleted: true });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du défi.' });
  }
});

module.exports = router;

