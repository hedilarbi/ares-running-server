const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Badge = require('../models/Badge');
const UserBadge = require('../models/UserBadge');
const { authenticateToken } = require('../middleware/auth');

// GET /api/users/suggestions
router.get('/suggestions', authenticateToken, async (req, res) => {
  try {
    const currentUser = req.userDB;
    
    // We want a max of 10 suggestions
    const limit = 10;
    const suggestions = [];
    
    // Do not suggest the current user, nor any user they are already following
    const excludedIds = new Set([
      currentUser._id.toString(),
      ...(currentUser.following || []).map(id => id.toString())
    ]);

    // Query template for role 'user' and not in excludedIds
    const getBaseQuery = () => ({
      role: 'user',
      _id: { $nin: Array.from(excludedIds) }
    });

    // Step 1: Priority to users in the same city
    if (currentUser.city) {
      const sameCityUsers = await User.find({
        ...getBaseQuery(),
        city: currentUser.city
      })
      .select('name pseudo city governorate photo level xp createdAt')
      .limit(limit)
      .lean();

      sameCityUsers.forEach(u => {
        suggestions.push({ ...u, relation: 'Même ville' });
        excludedIds.add(u._id.toString());
      });
    }

    // Step 2: Users in the same governorate (but different city)
    if (suggestions.length < limit && currentUser.governorate) {
      const sameGovUsers = await User.find({
        ...getBaseQuery(),
        governorate: currentUser.governorate
      })
      .select('name pseudo city governorate photo level xp createdAt')
      .limit(limit - suggestions.length)
      .lean();

      sameGovUsers.forEach(u => {
        suggestions.push({ ...u, relation: 'Même gouvernorat' });
        excludedIds.add(u._id.toString());
      });
    }

    // Step 3: Remaining users (any other location)
    if (suggestions.length < limit) {
      const otherUsers = await User.find({
        ...getBaseQuery()
      })
      .select('name pseudo city governorate photo level xp createdAt')
      .limit(limit - suggestions.length)
      .lean();

      otherUsers.forEach(u => {
        suggestions.push({ ...u, relation: 'Nouveau' });
        excludedIds.add(u._id.toString());
      });
    }

    res.status(200).json({ suggestions });
  } catch (error) {
    console.error('Erreur lors de la récupération des suggestions:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des suggestions.' });
  }
});

// POST /api/users/:id/follow
router.post('/:id/follow', authenticateToken, async (req, res) => {
  try {
    const currentUser = req.userDB;
    const targetUserId = req.params.id;

    if (currentUser._id.toString() === targetUserId) {
      return res.status(400).json({ error: "Vous ne pouvez pas vous suivre vous-même." });
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: "Utilisateur introuvable." });
    }

    const isFollowing = currentUser.following.includes(targetUserId);

    if (isFollowing) {
      // Unfollow
      currentUser.following.pull(targetUserId);
      targetUser.followers.pull(currentUser._id);
    } else {
      // Follow
      currentUser.following.push(targetUserId);
      targetUser.followers.push(currentUser._id);
    }

    await currentUser.save();
    await targetUser.save();

    res.status(200).json({ 
      success: true, 
      isFollowing: !isFollowing,
      followers: currentUser.followers,
      following: currentUser.following 
    });
  } catch (error) {
    console.error('Erreur lors du follow/unfollow:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de l\'abonnement.' });
  }
});

// GET /api/users/me/badges — full catalog merged with what the caller unlocked,
// so the profile can show earned and still-locked badges side by side.
// Declared before '/:id' so the literal path is not captured as an id.
router.get('/me/badges', authenticateToken, async (req, res) => {
  try {
    const [catalog, earned] = await Promise.all([
      Badge.find({ isActive: true }).sort({ category: 1, createdAt: 1 }).lean(),
      UserBadge.find({ user: req.userDB._id }).select('badge unlockedAt').lean(),
    ]);

    const unlockedAtByBadgeId = new Map(
      earned.map((entry) => [entry.badge.toString(), entry.unlockedAt]),
    );

    const badges = catalog.map((badge) => {
      const unlockedAt = unlockedAtByBadgeId.get(badge._id.toString()) || null;
      return {
        id: badge._id.toString(),
        key: badge.key,
        label: badge.label,
        description: badge.description || '',
        imageUrl: badge.image?.url || null,
        category: badge.category,
        xpReward: badge.xpReward,
        unlocked: unlockedAt !== null,
        unlockedAt,
      };
    });

    // Unlocked first, most recent first, so the profile shows achievements
    // before the ones still to earn.
    badges.sort((a, b) => {
      if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
      if (a.unlocked && b.unlocked) return new Date(b.unlockedAt) - new Date(a.unlockedAt);
      return 0;
    });

    return res.status(200).json({
      badges,
      unlockedCount: badges.filter((badge) => badge.unlocked).length,
      totalCount: badges.length,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des badges:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des badges.' });
  }
});

// GET /api/users/search
router.get('/search', authenticateToken, async (req, res) => {
  try {
    // `q` can arrive as an array (?q=a&q=b), and is matched literally: a raw
    // RegExp lets anyone send a pattern that stalls the database.
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '';
    if (!query) {
      return res.status(200).json({ users: [] });
    }

    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({
      role: 'user',
      _id: { $ne: req.userDB._id },
      $or: [
        { name: regex },
        { pseudo: regex },
        { city: regex },
        { governorate: regex }
      ]
    })
    .select('name pseudo city governorate photo level xp followers following createdAt')
    .limit(20)
    .lean();

    res.status(200).json({ users });
  } catch (error) {
    console.error('Erreur lors de la recherche:', error);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/users/rankings
router.get('/rankings', authenticateToken, async (req, res) => {
  try {
    const { scope } = req.query; // 'city', 'governorate', 'country'
    const currentUser = req.userDB;
    
    let matchCondition = { role: 'user' };
    
    if (scope === 'city') {
      if (!currentUser.city) return res.status(200).json({ rankings: [] });
      matchCondition.city = currentUser.city;
    } else if (scope === 'governorate') {
      if (!currentUser.governorate) return res.status(200).json({ rankings: [] });
      matchCondition.governorate = currentUser.governorate;
    } else if (scope === 'country') {
      if (!currentUser.country) return res.status(200).json({ rankings: [] });
      matchCondition.country = currentUser.country;
    } else {
      return res.status(400).json({ error: 'Scope invalide.' });
    }

    const usersAggr = await User.aggregate([
      { $match: matchCondition },
      { 
         $lookup: { 
           from: 'runs', 
           let: { userId: '$_id' },
           pipeline: [
              { $match: { $expr: { $eq: ['$user', '$$userId'] } } },
              { $group: { _id: null, totalDistance: { $sum: '$distanceMetres' } } }
           ],
           as: 'runsData'
         } 
      },
      { $addFields: { totalDistance: { $ifNull: [{ $arrayElemAt: ['$runsData.totalDistance', 0] }, 0] } } },
      { $sort: { totalDistance: -1 } },
      { $project: { _id: 1, name: 1, pseudo: 1, photo: 1, totalDistance: 1 } }
    ]);

    const rankings = usersAggr.map((u, index) => ({
      rank: index + 1,
      id: u._id.toString(),
      name: u.pseudo || u.name || 'Utilisateur',
      photo: u.photo || null,
      distanceMetres: u.totalDistance
    }));

    res.status(200).json({ rankings });
  } catch (error) {
    console.error('Erreur lors du calcul du classement:', error);
    res.status(500).json({ error: 'Erreur lors du calcul du classement.' });
  }
});

// GET /api/users/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const targetUserId = req.params.id;
    if (targetUserId === 'search' || targetUserId === 'suggestions') {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const targetUser = await User.findById(targetUserId).select('-password -otpCode').lean();
    if (!targetUser) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    res.status(200).json({ user: targetUser });
  } catch (error) {
    console.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
