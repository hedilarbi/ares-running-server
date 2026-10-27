const jwt = require('jsonwebtoken');
const User = require('../models/User');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// The fallback is public (it is in the repository): anyone can sign a token
// with it, including `role: 'admin'`. Production must set JWT_SECRET.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET doit être défini en production.');
  }
  console.warn('⚠️  JWT_SECRET absent : clé de développement utilisée. Ne pas déployer ainsi.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'ares_secret_key_2026_super_secure';

const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user._id, 
      email: user.email, 
      role: user.role 
    }, 
    JWT_SECRET, 
    { expiresIn: '30d' }
  );
};

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Accès refusé. Aucun jeton fourni.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    
    const userDB = await User.findById(decoded.id);
    if (!userDB) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    
    req.userDB = userDB;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Jeton invalide ou expiré.' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ error: 'Accès refusé. Rôle administrateur requis.' });
  }
};

module.exports = {
  generateToken,
  authenticateToken,
  isAdmin,
  JWT_SECRET
};
