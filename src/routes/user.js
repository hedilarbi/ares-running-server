const express = require('express');
const router = express.Router();
const User = require('../models/User');
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

// GET /api/users/search
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const query = req.query.q || '';
    if (!query) {
      return res.status(200).json({ users: [] });
    }

    const regex = new RegExp(query, 'i');
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
