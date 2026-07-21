const express = require('express');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const { generateToken, authenticateToken, isAdmin } = require('../middleware/auth');

const router = express.Router();

// 1. ADMIN LOGIN
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Accès refusé. Identifiants administrateur invalides.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Accès refusé. Identifiants administrateur invalides.' });
    }

    const token = generateToken(user);

    return res.status(200).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la connexion administrateur.' });
  }
});

// 2. CURRENT ADMIN SESSION (ADMIN ONLY)
router.get('/me', authenticateToken, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -otpCode -otpExpiresAt');

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Accès refusé. Rôle administrateur requis.' });
    }

    return res.status(200).json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Admin me error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la vérification de session.' });
  }
});

// 3. LIST USERS (ADMIN ONLY)
router.get('/users', authenticateToken, isAdmin, async (req, res) => {
  const { search } = req.query;
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);
  const skip = (page - 1) * limit;

  try {
    let query = { role: 'user' };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { city: { $regex: search, $options: 'i' } },
        { country: { $regex: search, $options: 'i' } }
      ];
    }

    const [users, total] = await Promise.all([
      User.find(query)
      .select('-password -otpCode -otpExpiresAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments(query)
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.status(200).json({
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Admin list users error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération des utilisateurs.' });
  }
});

// 4. GET SINGLE USER DETAILS (ADMIN ONLY)
router.get('/users/:id', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findOne({ _id: id, role: 'user' }).select('-password -otpCode -otpExpiresAt');

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    return res.status(200).json({ user });
  } catch (error) {
    console.error('Admin get user error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération de l\'utilisateur.' });
  }
});

module.exports = router;
