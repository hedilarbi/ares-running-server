const express = require('express');
const multer = require('multer');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const Run = require('../models/Run');
const Badge = require('../models/Badge');
const UserBadge = require('../models/UserBadge');
const Defi = require('../models/Defi');
const UserDefi = require('../models/UserDefi');
const { generateToken, authenticateToken, isAdmin } = require('../middleware/auth');
const { deleteImage, uploadImage } = require('../image-storage');
const { completeReachedDefi, revokeAwardedXp } = require('../services/rewardsService');
const { getPeriodId } = require('../utils/time');

const router = express.Router();

const MAXIMUM_BADGE_IMAGE_BYTES = 8 * 1024 * 1024;
const BADGE_CATEGORIES = ['distance', 'frequence', 'vitesse', 'social', 'special'];
const BADGE_CRITERIA_TYPES = ['distance_totale', 'nb_courses', 'distance_course', 'vitesse_max', 'manuel'];
const DEFI_KINDS = ['individuel', 'amis', 'clubs'];
// 'custom' stays in the model for old défis but has no automatic rule, so a
// new one could never be completed.
const DEFI_GOAL_TYPES = ['distance', 'nb_courses', 'vitesse'];

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAXIMUM_BADGE_IMAGE_BYTES, files: 1 },
});

const receiveImage = (req, res, next) => {
  imageUpload.single('image')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: "L'image dépasse la taille maximale autorisée (8 Mo)." });
    }

    return res.status(400).json({ error: "Impossible de lire l'image envoyée." });
  });
};

function parseConditionConfig(rawConfig) {
  if (!rawConfig) return {};
  try {
    const config = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    return {
      isPerRun: config.isPerRun === true || config.isPerRun === 'true',
      timeConstraint: ['none', 'before_8am', 'after_8pm'].includes(config.timeConstraint) ? config.timeConstraint : 'none',
      durationMinutes: Number.isFinite(Number(config.durationMinutes)) ? Math.max(0, Number(config.durationMinutes)) : 0,
      consecutiveDays: Number.isFinite(Number(config.consecutiveDays)) ? Math.max(0, Number(config.consecutiveDays)) : 0,
      beatPrevious: config.beatPrevious === true || config.beatPrevious === 'true',
      // Not evaluated by the rewards engine yet: always cleared, so saving a
      // badge or défi cannot promise a condition nobody checks.
      uniqueLocations: 0,
      ranking: 'none',
    };
  } catch (e) {
    return {};
  }
}

function parseBadgePayload(body) {
  const { key, label, description, category, criteriaType, criteriaThreshold, conditionConfig, xpReward, isActive } = body;

  if (!key || typeof key !== 'string' || !key.trim()) {
    throw Object.assign(new Error('La clé du badge est requise.'), { status: 400 });
  }
  if (!label || typeof label !== 'string' || !label.trim()) {
    throw Object.assign(new Error('Le nom du badge est requis.'), { status: 400 });
  }
  if (!BADGE_CATEGORIES.includes(category)) {
    throw Object.assign(new Error('Catégorie de badge invalide.'), { status: 400 });
  }
  if (!BADGE_CRITERIA_TYPES.includes(criteriaType)) {
    throw Object.assign(new Error("Type de critère d'obtention invalide."), { status: 400 });
  }
  // A zero threshold would unlock the badge on anyone's next run.
  if (criteriaType !== 'manuel' && !(Number(criteriaThreshold) > 0)) {
    throw Object.assign(new Error('Le seuil du critère doit être supérieur à 0.'), { status: 400 });
  }

  return {
    key: key.trim(),
    label: label.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    category,
    criteriaType,
    criteriaThreshold: Number.isFinite(Number(criteriaThreshold)) ? Math.max(0, Number(criteriaThreshold)) : 0,
    conditionConfig: parseConditionConfig(conditionConfig),
    xpReward: Number.isFinite(Number(xpReward)) ? Math.max(0, Number(xpReward)) : 0,
    isActive: isActive === undefined ? true : isActive === 'true' || isActive === true,
  };
}

function parseDefiPayload(body) {
  const { title, description, kind, goalType, goalValue, conditionConfig, period, xpReward, isActive } = body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    throw Object.assign(new Error('Le titre du défi est requis.'), { status: 400 });
  }
  if (!DEFI_KINDS.includes(kind)) {
    throw Object.assign(new Error('Type de défi invalide.'), { status: 400 });
  }
  if (!DEFI_GOAL_TYPES.includes(goalType)) {
    throw Object.assign(new Error("Type d'objectif invalide."), { status: 400 });
  }

  const goalValueNumber = Number(goalValue);
  // A zero goal would complete the défi on anyone's next run.
  if (!Number.isFinite(goalValueNumber) || goalValueNumber <= 0) {
    throw Object.assign(new Error("La valeur cible de l'objectif est invalide."), { status: 400 });
  }

  if (!['quotidien', 'hebdomadaire', 'mensuel'].includes(period)) {
    throw Object.assign(new Error('Périodicité invalide.'), { status: 400 });
  }

  return {
    title: title.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    kind,
    goalType,
    goalValue: goalValueNumber,
    conditionConfig: parseConditionConfig(conditionConfig),
    period,
    xpReward: Number.isFinite(Number(xpReward)) ? Math.max(0, Number(xpReward)) : 0,
    isActive: isActive === undefined ? true : isActive === 'true' || isActive === true,
  };
}

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

// 5. GET A USER'S RUN HISTORY (ADMIN ONLY)
router.get('/users/:id/runs', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);
  const skip = (page - 1) * limit;

  try {
    const user = await User.findOne({ _id: id, role: 'user' }).select('_id');
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const [runs, total] = await Promise.all([
      // routePoints is excluded: it can hold tens of thousands of GPS
      // samples and admins only need the run summary here.
      Run.find({ user: id })
        .select('-routePoints')
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit),
      Run.countDocuments({ user: id }),
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.status(200).json({
      runs,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error('Admin get user runs error:', error);
    return res.status(500).json({ error: "Une erreur est survenue lors de la récupération de l'historique des courses." });
  }
});

// 6. GET A USER'S BADGES (CATALOG MERGED WITH UNLOCK STATUS, ADMIN ONLY)
router.get('/users/:id/badges', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findOne({ _id: id, role: 'user' }).select('_id');
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const [catalog, earned] = await Promise.all([
      Badge.find({ isActive: true }).sort({ category: 1, createdAt: 1 }),
      UserBadge.find({ user: id }).select('badge unlockedAt'),
    ]);

    const unlockedAtByBadgeId = new Map(
      earned.map((entry) => [entry.badge.toString(), entry.unlockedAt]),
    );

    const badges = catalog.map((badge) => ({
      id: badge._id,
      key: badge.key,
      label: badge.label,
      description: badge.description,
      imageUrl: badge.image?.url || null,
      category: badge.category,
      xpReward: badge.xpReward,
      unlocked: unlockedAtByBadgeId.has(badge._id.toString()),
      unlockedAt: unlockedAtByBadgeId.get(badge._id.toString()) || null,
    }));

    return res.status(200).json({ badges });
  } catch (error) {
    console.error('Admin get user badges error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération des badges.' });
  }
});

// 7. GET A USER'S DEFIS, GROUPED BY STATUS (ADMIN ONLY)
router.get('/users/:id/defis', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findOne({ _id: id, role: 'user' }).select('_id');
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const [participations, activeDefis] = await Promise.all([
      UserDefi.find({ user: id }).populate('defi').sort({ joinedAt: -1 }),
      Defi.find({ isActive: true }),
    ]);

    // Défis restart every period: "available" means not joined in the current one.
    const now = new Date();
    const joinedDefiIds = new Set(
      participations
        .filter((entry) => entry.defi && entry.periodId === getPeriodId(now, entry.defi.period))
        .map((entry) => entry.defi._id.toString()),
    );

    const serializeParticipation = (entry) => {
      const defi = entry.defi;
      const pct = defi.goalValue > 0
        ? Math.min(100, Math.round((entry.progressValue / defi.goalValue) * 100))
        : 0;

      return {
        id: defi._id,
        title: defi.title,
        description: defi.description,
        kind: defi.kind,
        goalType: defi.goalType,
        goalValue: defi.goalValue,
        progressValue: entry.progressValue,
        pct,
        status: entry.status,
        xpReward: defi.xpReward,
        period: defi.period,
        joinedAt: entry.joinedAt,
        completedAt: entry.completedAt,
      };
    };

    const enCours = participations
      .filter((entry) => entry.defi && entry.status === 'en_cours')
      .map(serializeParticipation);

    const termines = participations
      .filter((entry) => entry.defi && entry.status !== 'en_cours')
      .map(serializeParticipation);

    const disponibles = activeDefis
      .filter((defi) => !joinedDefiIds.has(defi._id.toString()))
      .map((defi) => ({
        id: defi._id,
        title: defi.title,
        description: defi.description,
        kind: defi.kind,
        goalType: defi.goalType,
        goalValue: defi.goalValue,
        xpReward: defi.xpReward,
        period: defi.period,
      }));

    return res.status(200).json({ enCours, disponibles, termines });
  } catch (error) {
    console.error('Admin get user defis error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération des défis.' });
  }
});

// 8. LIST BADGE CATALOG (ADMIN ONLY)
router.get('/badges', authenticateToken, isAdmin, async (req, res) => {
  try {
    const badges = await Badge.find().sort({ createdAt: -1 });
    return res.status(200).json({ badges });
  } catch (error) {
    console.error('Admin list badges error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération des badges.' });
  }
});

// 8bis. GET A SINGLE BADGE (ADMIN ONLY)
router.get('/badges/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const badge = await Badge.findById(req.params.id);
    if (!badge) {
      return res.status(404).json({ error: 'Badge introuvable.' });
    }
    return res.status(200).json({ badge });
  } catch (error) {
    console.error('Admin get badge error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération du badge.' });
  }
});

// 9. CREATE A BADGE (ADMIN ONLY)
router.post('/badges', authenticateToken, isAdmin, receiveImage, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "L'image du badge est requise." });
  }

  let uploadedImage = null;

  try {
    const payload = parseBadgePayload(req.body);

    const existing = await Badge.findOne({ key: payload.key });
    if (existing) {
      return res.status(409).json({ error: 'Un badge avec cette clé existe déjà.' });
    }

    uploadedImage = await uploadImage(req.file.buffer, 'badges');

    const badge = await Badge.create({ ...payload, image: uploadedImage });
    return res.status(201).json({ badge });
  } catch (error) {
    if (uploadedImage) {
      await deleteImage(uploadedImage.path).catch(() => {});
    }
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Admin create badge error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la création du badge.' });
  }
});

// 10. UPDATE A BADGE (ADMIN ONLY)
router.put('/badges/:id', authenticateToken, isAdmin, receiveImage, async (req, res) => {
  const { id } = req.params;
  let uploadedImage = null;

  try {
    const badge = await Badge.findById(id);
    if (!badge) {
      return res.status(404).json({ error: 'Badge introuvable.' });
    }

    const payload = parseBadgePayload(req.body);

    if (payload.key !== badge.key) {
      const existing = await Badge.findOne({ key: payload.key, _id: { $ne: id } });
      if (existing) {
        return res.status(409).json({ error: 'Un badge avec cette clé existe déjà.' });
      }
    }

    Object.assign(badge, payload);

    if (req.file) {
      uploadedImage = await uploadImage(req.file.buffer, 'badges');
      const previousImagePath = badge.image?.path;
      badge.image = uploadedImage;
      if (previousImagePath) {
        await deleteImage(previousImagePath).catch(() => {});
      }
    }

    await badge.save();
    return res.status(200).json({ badge });
  } catch (error) {
    if (uploadedImage) {
      await deleteImage(uploadedImage.path).catch(() => {});
    }
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Admin update badge error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la mise à jour du badge.' });
  }
});

// 11. DELETE A BADGE (ADMIN ONLY)
router.delete('/badges/:id', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const badge = await Badge.findById(id);
    if (!badge) {
      return res.status(404).json({ error: 'Badge introuvable.' });
    }

    // The XP this badge paid goes with it, or deleting and recreating a badge
    // would pay its reward twice.
    const awarded = await UserBadge.find({ badge: id }).select('user xpAwarded').lean();
    await revokeAwardedXp(awarded, badge.xpReward || 0);

    await Promise.all([
      Badge.deleteOne({ _id: id }),
      UserBadge.deleteMany({ badge: id }),
    ]);

    if (badge.image?.path) {
      await deleteImage(badge.image.path).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Admin delete badge error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la suppression du badge.' });
  }
});

// 12. LIST DEFI CATALOG (ADMIN ONLY)
router.get('/defis', authenticateToken, isAdmin, async (req, res) => {
  try {
    const defis = await Defi.find().sort({ createdAt: -1 });
    return res.status(200).json({ defis });
  } catch (error) {
    console.error('Admin list defis error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération des défis.' });
  }
});

// 12bis. GET A SINGLE DEFI (ADMIN ONLY)
router.get('/defis/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const defi = await Defi.findById(req.params.id);
    if (!defi) {
      return res.status(404).json({ error: 'Défi introuvable.' });
    }
    return res.status(200).json({ defi });
  } catch (error) {
    console.error('Admin get defi error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la récupération du défi.' });
  }
});

// 13. CREATE A DEFI (ADMIN ONLY)
router.post('/defis', authenticateToken, isAdmin, receiveImage, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "L'image du défi est requise." });
  }

  let uploadedImage = null;

  try {
    const payload = parseDefiPayload(req.body);
    uploadedImage = await uploadImage(req.file.buffer, 'defis');

    const defi = await Defi.create({ ...payload, image: uploadedImage });
    return res.status(201).json({ defi });
  } catch (error) {
    if (uploadedImage) {
      await deleteImage(uploadedImage.path).catch(() => {});
    }
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Admin create defi error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la création du défi.' });
  }
});

// 14. UPDATE A DEFI (ADMIN ONLY)
router.put('/defis/:id', authenticateToken, isAdmin, receiveImage, async (req, res) => {
  const { id } = req.params;
  let uploadedImage = null;

  try {
    const defi = await Defi.findById(id);
    if (!defi) {
      return res.status(404).json({ error: 'Défi introuvable.' });
    }

    const payload = parseDefiPayload(req.body);

    // Progress is stored per period: switching daily → weekly would silently
    // orphan everyone's current progress.
    if (payload.period !== defi.period) {
      const inProgress = await UserDefi.exists({ defi: id, status: 'en_cours', progressValue: { $gt: 0 } });
      if (inProgress) {
        return res.status(409).json({
          error: 'Des utilisateurs ont déjà progressé sur ce défi : créez un nouveau défi pour changer sa périodicité.',
        });
      }
    }

    Object.assign(defi, payload);

    if (req.file) {
      uploadedImage = await uploadImage(req.file.buffer, 'defis');
      const previousImagePath = defi.image?.path;
      defi.image = uploadedImage;
      if (previousImagePath) {
        await deleteImage(previousImagePath).catch(() => {});
      }
    }

    await defi.save();
    // A lowered goal may already be met by this period's progress.
    await completeReachedDefi(defi);

    return res.status(200).json({ defi });
  } catch (error) {
    if (uploadedImage) {
      await deleteImage(uploadedImage.path).catch(() => {});
    }
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Admin update defi error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la mise à jour du défi.' });
  }
});

// 15. DELETE A DEFI (ADMIN ONLY)
router.delete('/defis/:id', authenticateToken, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const defi = await Defi.findById(id);
    if (!defi) {
      return res.status(404).json({ error: 'Défi introuvable.' });
    }

    const participations = await UserDefi.find({ defi: id }).select('user status xpAwarded').lean();
    await revokeAwardedXp(participations, defi.xpReward || 0);

    await Promise.all([
      Defi.deleteOne({ _id: id }),
      UserDefi.deleteMany({ defi: id }),
    ]);

    if (defi.image?.path) {
      await deleteImage(defi.image.path).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Admin delete defi error:', error);
    return res.status(500).json({ error: 'Une erreur est survenue lors de la suppression du défi.' });
  }
});

module.exports = router;
