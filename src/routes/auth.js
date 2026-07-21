const express = require('express');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const { verifyFirebaseToken } = require('../firebase-verifier');
const { generateToken, authenticateToken } = require('../middleware/auth');
const { sendOTPEmail, sendResetPasswordOTPEmail } = require('../email');
const { uploadBase64ToFirebase } = require('../storage');

const router = express.Router();

// Helper to generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// 1. REGISTER
router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(400).json({ error: 'Cet email est déjà enregistré.' });
      } else {
        // User registered but did not verify. Re-send OTP.
        const otpCode = generateOTP();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

        existingUser.password = await bcrypt.hash(password, 10);
        existingUser.otpCode = otpCode;
        existingUser.otpExpiresAt = otpExpiresAt;

        await existingUser.save();
        await sendOTPEmail(email, otpCode);

        return res.status(200).json({ 
          message: 'Code de vérification renvoyé.',
          email: email
        });
      }
    }

    // New user registration
    const hashedPassword = await bcrypt.hash(password, 10);
    const otpCode = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    const newUser = new User({
      email,
      password: hashedPassword,
      otpCode,
      otpExpiresAt,
      isVerified: false,
    });

    await newUser.save();
    
    // Send email asynchronously so API responds quickly
    sendOTPEmail(email, otpCode);

    return res.status(201).json({
      message: 'Inscription réussie. Code de vérification envoyé par email.',
      email: email
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de l\'inscription.' });
  }
});

// 2. VERIFY OTP
router.post('/verify-otp', async (req, res) => {
  const { email, otpCode } = req.body;

  if (!email || !otpCode) {
    return res.status(400).json({ error: 'Email et code OTP requis.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    if (user.isVerified) {
      return res.status(400).json({ error: 'Ce compte est déjà vérifié.' });
    }

    if (user.otpCode !== otpCode) {
      return res.status(400).json({ error: 'Code de vérification invalide.' });
    }

    if (new Date() > user.otpExpiresAt) {
      return res.status(400).json({ error: 'Code de vérification expiré. Veuillez vous réinscrire.' });
    }

    // Mark as verified
    user.isVerified = true;
    user.otpCode = '';
    user.otpExpiresAt = undefined;
    await user.save();

    const token = generateToken(user);

    return res.status(200).json({
      message: 'Compte vérifié avec succès.',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        pseudo: user.pseudo,
        photo: user.photo,
        provider: user.provider,
        sex: user.sex,
        dateOfBirth: user.dateOfBirth,
        height: user.height,
        weight: user.weight,
        city: user.city,
        governorate: user.governorate,
        country: user.country,
        level: user.level,
        xp: user.xp,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la vérification.' });
  }
});

// 3. LOGIN
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }

    if (!user.isVerified) {
      // User is not verified yet, send a new OTP and inform the client
      const otpCode = generateOTP();
      user.otpCode = otpCode;
      user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await user.save();
      sendOTPEmail(email, otpCode);

      return res.status(403).json({
        error: 'Veuillez vérifier votre adresse email. Un nouveau code vous a été envoyé.',
        needsVerification: true,
        email: user.email
      });
    }

    const token = generateToken(user);

    return res.status(200).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        pseudo: user.pseudo,
        photo: user.photo,
        provider: user.provider,
        sex: user.sex,
        dateOfBirth: user.dateOfBirth,
        height: user.height,
        weight: user.weight,
        city: user.city,
        governorate: user.governorate,
        country: user.country,
        level: user.level,
        xp: user.xp,
        role: user.role,
        followers: user.followers || [],
        following: user.following || []
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la connexion.' });
  }
});

// 4. FIREBASE SOCIAL LOGIN (GOOGLE / APPLE)
router.post('/firebase-login', async (req, res) => {
  const { idToken, email: clientEmail, name: clientName, photo: clientPhoto, provider: clientProvider } = req.body;

  try {
    let email = clientEmail;
    let name = clientName || 'Utilisateur Ares';
    let photo = clientPhoto || '';
    let provider = clientProvider === 'apple' ? 'apple' : 'google';

    // Verify token using custom Firebase verifier if token is supplied
    if (idToken && idToken !== 'mock-token') {
      try {
        const decodedToken = await verifyFirebaseToken(idToken);
        email = decodedToken.email;
        name = decodedToken.name || name;
        photo = decodedToken.picture || photo;
        const signInProvider = decodedToken.firebase?.sign_in_provider || '';
        if (signInProvider.includes('apple')) provider = 'apple';
        else if (signInProvider.includes('google')) provider = 'google';
      } catch (err) {
        console.error('Firebase token custom verification failed:', err.message);
        if (!email) {
          return res.status(401).json({ error: 'Jeton Firebase invalide.' });
        }
      }
    } else {
      // Fallback/Mock Mode if firebase admin is not initialized or we pass a mock token
      console.log('Firebase mock login fallback.');
      if (!email) {
        return res.status(400).json({ error: 'Email requis en mode de connexion sociale simulée.' });
      }
    }

    // Check if user already exists
    let user = await User.findOne({ email });

    if (!user) {
      // Auto-register and verify social user
      const placeholderPassword = await bcrypt.hash(Math.random().toString(36), 10);
      user = new User({
        email,
        password: placeholderPassword,
        name,
        photo,
        provider,
        isVerified: true
      });
      await user.save();
    } else {
      // If user exists but is not verified, auto-verify them since they logged in via OAuth
      if (!user.isVerified) {
        user.isVerified = true;
        await user.save();
      }
    }

    const token = generateToken(user);

    return res.status(200).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        pseudo: user.pseudo,
        photo: user.photo,
        provider: user.provider,
        sex: user.sex,
        dateOfBirth: user.dateOfBirth,
        height: user.height,
        weight: user.weight,
        city: user.city,
        governorate: user.governorate,
        country: user.country,
        level: user.level,
        xp: user.xp,
        role: user.role,
        followers: user.followers || [],
        following: user.following || []
      }
    });
  } catch (error) {
    console.error('Firebase login error:', error);
    return res.status(500).json({ error: 'Erreur lors de la connexion sociale.' });
  }
});

// 5. PROFILE SETUP & EDIT
const PSEUDO_REGEX = /^[a-zA-Z0-9_.]+$/;

router.put('/profile-setup', authenticateToken, async (req, res) => {
  const { name, pseudo, sex, dateOfBirth, height, weight, city, governorate, country, photo } = req.body;

  try {
    const user = req.userDB;

    if (pseudo !== undefined) {
      if (!PSEUDO_REGEX.test(pseudo)) {
        return res.status(400).json({ error: 'Le pseudo ne peut contenir que des lettres, des chiffres, "_" et "."' });
      }
      const existingPseudo = await User.findOne({ pseudo, _id: { $ne: user._id } });
      if (existingPseudo) {
        return res.status(400).json({ error: 'Ce pseudo est déjà pris.' });
      }
      user.pseudo = pseudo;
    }

    if (name !== undefined) user.name = name;
    if (sex !== undefined) user.sex = sex;
    if (dateOfBirth !== undefined) user.dateOfBirth = dateOfBirth;
    if (height !== undefined) user.height = height;
    if (weight !== undefined) user.weight = weight;
    if (city !== undefined) user.city = city;
    if (governorate !== undefined) user.governorate = governorate;
    if (country !== undefined) user.country = country;
    if (photo !== undefined) {
      const uploadedUrl = await uploadBase64ToFirebase(photo, user._id);
      user.photo = uploadedUrl;
    }

    await user.save();

    return res.status(200).json({
      message: 'Profil mis à jour avec succès.',
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        pseudo: user.pseudo,
        photo: user.photo,
        provider: user.provider,
        sex: user.sex,
        dateOfBirth: user.dateOfBirth,
        height: user.height,
        weight: user.weight,
        city: user.city,
        governorate: user.governorate,
        country: user.country,
        level: user.level,
        xp: user.xp,
        role: user.role,
        followers: user.followers || [],
        following: user.following || []
      }
    });
  } catch (error) {
    console.error('Profile setup error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la mise à jour du profil.' });
  }
});

// 6. ME
router.get('/me', authenticateToken, async (req, res) => {
  const user = req.userDB;
  return res.status(200).json({
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      pseudo: user.pseudo,
      photo: user.photo,
      provider: user.provider,
      sex: user.sex,
      dateOfBirth: user.dateOfBirth,
      height: user.height,
      weight: user.weight,
      city: user.city,
      governorate: user.governorate,
      country: user.country,
      level: user.level,
      xp: user.xp,
      role: user.role,
      followers: user.followers || [],
      following: user.following || []
    }
  });
});

// 7. FORGOT PASSWORD
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Adresse e-mail requise.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: 'Aucun compte associé à cette adresse e-mail.' });
    }

    const otpCode = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.otpCode = otpCode;
    user.otpExpiresAt = otpExpiresAt;
    await user.save();

    sendResetPasswordOTPEmail(email, otpCode);

    return res.status(200).json({
      message: 'Code de réinitialisation envoyé par e-mail.',
      email: email
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la demande de réinitialisation.' });
  }
});

// 8. RESET PASSWORD
router.post('/reset-password', async (req, res) => {
  const { email, otpCode, newPassword } = req.body;

  if (!email || !otpCode || !newPassword) {
    return res.status(400).json({ error: 'E-mail, code de vérification et nouveau mot de passe requis.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    if (user.otpCode !== otpCode) {
      return res.status(400).json({ error: 'Code de vérification invalide.' });
    }

    if (new Date() > user.otpExpiresAt) {
      return res.status(400).json({ error: 'Code de vérification expiré. Veuillez refaire la demande.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.otpCode = '';
    user.otpExpiresAt = undefined;
    await user.save();

    return res.status(200).json({
      message: 'Mot de passe réinitialisé avec succès.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la réinitialisation.' });
  }
});

module.exports = router;
