const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const Run = require('../models/Run');
const { authenticateToken } = require('../middleware/auth');
const { deleteRunPhoto, uploadRunPhoto } = require('../run-photo-storage');
const { calculateRunMetrics, round } = require('../utils/runCalculations');
const {
  hasPendingRewards,
  processPendingRewards,
  processRunRewards,
} = require('../services/rewardsService');

const router = express.Router();

// Temporary product setting: accept stationary activities while the complete
// run saving flow is being tested.
const MINIMUM_DISTANCE_METRES = 0;
const MAXIMUM_DURATION_SECONDS = 7 * 24 * 60 * 60;
// Phone clocks drift a little; a run cannot end further in the future than this.
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAXIMUM_PHOTO_BYTES = 12 * 1024 * 1024;
const SUPPORTED_PHOTO_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const apiError = (status, code, message, details) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAXIMUM_PHOTO_BYTES,
    files: 1,
    fields: 1,
    fieldSize: 8 * 1024 * 1024,
  },
  fileFilter: (req, file, callback) => {
    if (!SUPPORTED_PHOTO_TYPES.has(file.mimetype.toLowerCase())) {
      return callback(apiError(
        415,
        'PHOTO_TYPE_UNSUPPORTED',
        'Format de photo non pris en charge. Utilisez JPEG, PNG, WebP, HEIC ou HEIF.',
      ));
    }
    return callback(null, true);
  },
});

const receiveMultipartRun = (req, res, next) => {
  upload.single('photo')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(apiError(413, 'PHOTO_TOO_LARGE', 'La photo ne doit pas dépasser 12 Mo.'));
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(apiError(400, 'UNEXPECTED_FILE_FIELD', "Le fichier doit utiliser le champ 'photo'."));
      }
      return next(apiError(400, 'INVALID_MULTIPART', 'Formulaire multipart invalide.'));
    }

    return next(error);
  });
};

const finiteNumber = (value, fieldName) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw apiError(400, 'INVALID_RUN_PAYLOAD', `${fieldName} doit être un nombre valide.`);
  }
  return value;
};

const optionalFiniteNumber = (value, fieldName, { minimum } = {}) => {
  if (value === undefined || value === null) return null;
  const parsed = finiteNumber(value, fieldName);
  if (minimum !== undefined && parsed < minimum) return null;
  return parsed;
};

const timestampInMilliseconds = (value, fieldName) => {
  let timestamp = value;

  if (typeof timestamp === 'string' && timestamp.trim()) {
    const numericTimestamp = Number(timestamp);
    timestamp = Number.isFinite(numericTimestamp) ? numericTimestamp : Date.parse(timestamp);
  }

  timestamp = finiteNumber(timestamp, fieldName);
  // Native location timestamps use milliseconds. Accept Unix seconds too so
  // imported traces remain unambiguous.
  if (timestamp > 0 && timestamp < 100_000_000_000) timestamp *= 1000;

  if (timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime())) {
    throw apiError(400, 'INVALID_RUN_PAYLOAD', `${fieldName} est invalide.`);
  }
  return timestamp;
};

const validDate = (value, fieldName) => {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw apiError(400, 'INVALID_RUN_PAYLOAD', `${fieldName} est invalide.`);
  }
  return date;
};

const parseRunPayload = (rawRun) => {
  if (typeof rawRun !== 'string' || !rawRun.trim()) {
    throw apiError(400, 'RUN_FIELD_REQUIRED', "Le champ texte multipart 'run' est requis.");
  }

  let payload;
  try {
    payload = JSON.parse(rawRun);
  } catch (error) {
    throw apiError(400, 'INVALID_RUN_JSON', "Le champ 'run' doit contenir un JSON valide.");
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw apiError(400, 'INVALID_RUN_PAYLOAD', 'Les données de la course sont invalides.');
  }

  const clientRunId = typeof payload.clientRunId === 'string'
    ? payload.clientRunId.trim()
    : '';
  if (!clientRunId || clientRunId.length > 128) {
    throw apiError(
      400,
      'INVALID_CLIENT_RUN_ID',
      'clientRunId est requis et ne doit pas dépasser 128 caractères.',
    );
  }

  const startedAt = validDate(payload.startedAt, 'startedAt');
  const finishedAt = validDate(payload.finishedAt, 'finishedAt');
  if (finishedAt <= startedAt) {
    throw apiError(400, 'INVALID_RUN_DATES', 'finishedAt doit être postérieur à startedAt.');
  }

  if (finishedAt.getTime() > Date.now() + MAXIMUM_CLOCK_SKEW_MS) {
    throw apiError(400, 'INVALID_RUN_DATES', 'finishedAt ne peut pas être dans le futur.');
  }

  const durationSeconds = finiteNumber(payload.durationSeconds, 'durationSeconds');
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > MAXIMUM_DURATION_SECONDS
  ) {
    throw apiError(
      400,
      'INVALID_RUN_DURATION',
      'durationSeconds doit être un entier compris entre 1 seconde et 7 jours.',
    );
  }
  // Active time excludes pauses, so it can be shorter than the wall-clock
  // interval but never longer: a longer one would inflate pace-based rewards.
  if (durationSeconds > (finishedAt - startedAt) / 1000 + 60) {
    throw apiError(
      400,
      'INVALID_RUN_DURATION',
      'durationSeconds dépasse le temps écoulé entre startedAt et finishedAt.',
    );
  }

  if (!Array.isArray(payload.routePoints)) {
    throw apiError(400, 'INVALID_ROUTE_POINTS', 'routePoints doit être un tableau de points GPS.');
  }

  let previousTimestamp = -Infinity;
  const routePoints = payload.routePoints.map((point, index) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      throw apiError(400, 'INVALID_ROUTE_POINT', `routePoints[${index}] est invalide.`);
    }

    const latitude = finiteNumber(point.latitude, `routePoints[${index}].latitude`);
    const longitude = finiteNumber(point.longitude, `routePoints[${index}].longitude`);
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw apiError(
        400,
        'INVALID_ROUTE_POINT',
        `Les coordonnées de routePoints[${index}] sont invalides.`,
      );
    }

    const timestamp = timestampInMilliseconds(
      point.timestamp,
      `routePoints[${index}].timestamp`,
    );
    if (timestamp < previousTimestamp) {
      throw apiError(
        400,
        'UNSORTED_ROUTE_POINTS',
        'Les points GPS doivent être classés par timestamp croissant.',
      );
    }
    previousTimestamp = timestamp;

    return {
      latitude,
      longitude,
      timestamp,
      speed: optionalFiniteNumber(point.speed, `routePoints[${index}].speed`, { minimum: 0 }),
      accuracy: optionalFiniteNumber(
        point.accuracy,
        `routePoints[${index}].accuracy`,
        { minimum: 0 },
      ),
      altitude: optionalFiniteNumber(point.altitude, `routePoints[${index}].altitude`),
    };
  });

  return { clientRunId, startedAt, finishedAt, durationSeconds, routePoints };
};

const serializeRun = (run, { includeRoute = true } = {}) => {
  const value = typeof run.toObject === 'function' ? run.toObject() : run;
  const serialized = {
    id: value._id.toString(),
    clientRunId: value.clientRunId,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationSeconds: value.durationSeconds,
    distanceMetres: value.distanceMetres,
    averageSpeedMps: value.averageSpeedMps,
    maxSpeedMps: value.maxSpeedMps,
    averagePaceSecondsPerKm: value.averagePaceSecondsPerKm,
    caloriesKcal: value.caloriesKcal,
    photo: value.photo || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };

  if (includeRoute) serialized.routePoints = value.routePoints;
  return serialized;
};

// Keyset cursor for the activity feed, opaque to the client.
const encodeFeedCursor = (run) =>
  Buffer.from(`${new Date(run.startedAt).toISOString()}|${run._id}`, 'utf8').toString('base64url');

const decodeFeedCursor = (raw) => {
  const [startedAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const date = new Date(startedAt);

  if (Number.isNaN(date.getTime()) || !mongoose.Types.ObjectId.isValid(id)) {
    throw apiError(400, 'INVALID_CURSOR', 'cursor est invalide.');
  }

  return { startedAt: date, id: new mongoose.Types.ObjectId(id) };
};

const sendApiError = (res, error) => {
  const status = error.status || 500;
  if (status >= 500) console.error('Erreur API courses:', error);

  const response = {
    error: status >= 500 && !error.status
      ? 'Une erreur serveur est survenue.'
      : error.message,
    code: error.code || 'INTERNAL_SERVER_ERROR',
  };
  if (error.details) Object.assign(response, error.details);
  return res.status(status).json(response);
};

// POST /api/runs — the JSON is kept in a text field so a photo can travel in
// the same authenticated, idempotent multipart request.
router.post('/', authenticateToken, receiveMultipartRun, async (req, res) => {
  let uploadedPhoto = null;

  try {
    const payload = parseRunPayload(req.body?.run);

    const existingRun = await Run.findOne({
      user: req.userDB._id,
      clientRunId: payload.clientRunId,
    });
    if (existingRun) {
      // The first upload saved the run but its reward pass failed: finish it.
      const rewards = (await hasPendingRewards(existingRun._id))
        ? await processRunRewards(req.userDB._id, existingRun)
        : undefined;
      return res.status(200).json({ run: serializeRun(existingRun), rewards, idempotent: true });
    }

    const configuredWeight = Number(req.userDB.weight);
    const weightKg = Number.isFinite(configuredWeight) && configuredWeight > 0
      ? configuredWeight
      : 70;
    const metrics = calculateRunMetrics({
      routePoints: payload.routePoints,
      durationSeconds: payload.durationSeconds,
      weightKg,
    });

    if (metrics.rawDistanceMetres < MINIMUM_DISTANCE_METRES) {
      throw apiError(
        422,
        'RUN_TOO_SHORT',
        "Cette activité est trop courte pour être enregistrée.",
        {
          distanceMetres: metrics.distanceMetres,
          minimumDistanceMetres: MINIMUM_DISTANCE_METRES,
        },
      );
    }

    if (req.file) {
      uploadedPhoto = await uploadRunPhoto({
        buffer: req.file.buffer,
        userId: req.userDB._id.toString(),
      });
    }

    const run = new Run({
      user: req.userDB._id,
      clientRunId: payload.clientRunId,
      startedAt: payload.startedAt,
      finishedAt: payload.finishedAt,
      durationSeconds: payload.durationSeconds,
      distanceMetres: metrics.distanceMetres,
      averageSpeedMps: metrics.averageSpeedMps,
      maxSpeedMps: metrics.maxSpeedMps,
      averagePaceSecondsPerKm: metrics.averagePaceSecondsPerKm,
      caloriesKcal: metrics.caloriesKcal,
      routePoints: payload.routePoints,
      photo: uploadedPhoto,
    });

    try {
      await run.save();
      // From this point the database owns the uploaded object. A later response
      // serialization error must not remove a photo referenced by the saved run.
      uploadedPhoto = null;
    } catch (databaseError) {
      if (uploadedPhoto?.path) {
        try {
          await deleteRunPhoto(uploadedPhoto.path);
        } catch (rollbackError) {
          console.error('Rollback Firebase Storage impossible:', rollbackError);
        }
        uploadedPhoto = null;
      }

      // A concurrent retry can pass the first lookup and then lose the unique
      // index race. Return the winner instead of surfacing a duplicate error.
      if (databaseError?.code === 11000) {
        const concurrentRun = await Run.findOne({
          user: req.userDB._id,
          clientRunId: payload.clientRunId,
        });
        if (concurrentRun) {
          return res.status(200).json({
            run: serializeRun(concurrentRun),
            idempotent: true,
          });
        }
      }

      throw databaseError;
    }

    // The run is saved whatever happens next. A failed reward pass leaves it
    // pending and is retried on the next upload instead of failing this one.
    let processedRewards;
    try {
      processedRewards = await processRunRewards(req.userDB._id, run);
      await processPendingRewards(req.userDB._id);
    } catch (rewardsError) {
      console.error('Récompenses non attribuées, nouvel essai au prochain envoi:', rewardsError);
    }

    return res.status(201).json({ run: serializeRun(run), rewards: processedRewards, idempotent: false });
  } catch (error) {
    // This covers future errors occurring after upload but before Run#save.
    if (uploadedPhoto?.path) {
      try {
        await deleteRunPhoto(uploadedPhoto.path);
      } catch (rollbackError) {
        console.error('Rollback Firebase Storage impossible:', rollbackError);
      }
    }
    return sendApiError(res, error);
  }
});

// GET /api/runs/me/gallery?limit=20
router.get('/me/gallery', authenticateToken, async (req, res) => {
  try {
    const rawLimit = req.query.limit === undefined ? '20' : String(req.query.limit);
    if (!/^\d+$/.test(rawLimit)) {
      throw apiError(400, 'INVALID_LIMIT', 'limit doit être un entier positif.');
    }
    const limit = Math.min(Math.max(Number(rawLimit), 1), 50);

    const runs = await Run.find({
      user: req.userDB._id,
      'photo.url': { $exists: true, $ne: '' },
    })
      .select('_id photo.url startedAt distanceMetres')
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();

    const photos = runs.map((run) => ({
      id: run._id.toString(),
      imageUrl: run.photo.url,
      startedAt: run.startedAt,
      distanceMetres: run.distanceMetres,
    }));

    return res.status(200).json({ photos });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// GET /api/runs/me?limit=20&cursor=... — the caller's own run history, newest
// first. routePoints stay out of the list; GET /:id returns them.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const rawLimit = req.query.limit === undefined ? '20' : String(req.query.limit);
    if (!/^\d+$/.test(rawLimit)) {
      throw apiError(400, 'INVALID_LIMIT', 'limit doit être un entier positif.');
    }
    const limit = Math.min(Math.max(Number(rawLimit), 1), 50);

    const filter = { user: req.userDB._id };
    if (req.query.cursor !== undefined) {
      const cursor = decodeFeedCursor(String(req.query.cursor));
      filter.$or = [
        { startedAt: { $lt: cursor.startedAt } },
        { startedAt: cursor.startedAt, _id: { $lt: cursor.id } },
      ];
    }

    const runs = await Run.find(filter)
      .select('-routePoints')
      .sort({ startedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = runs.length > limit;
    const page = hasMore ? runs.slice(0, limit) : runs;
    const last = page[page.length - 1];

    return res.status(200).json({
      runs: page.map((run) => serializeRun(run, { includeRoute: false })),
      nextCursor: hasMore && last ? encodeFeedCursor(last) : null,
    });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// GET /api/runs/me/stats
router.get('/me/stats', authenticateToken, async (req, res) => {
  try {
    const [totals] = await Run.aggregate([
      { $match: { user: req.userDB._id } },
      {
        $group: {
          _id: null,
          distanceMetres: { $sum: '$distanceMetres' },
          runCount: { $sum: 1 },
          durationSeconds: { $sum: '$durationSeconds' },
        },
      },
    ]);

    return res.status(200).json({
      stats: {
        distanceMetres: round(totals?.distanceMetres || 0, 2),
        runCount: totals?.runCount || 0,
        durationSeconds: totals?.durationSeconds || 0,
      },
    });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// GET /api/runs/feed?limit=10&cursor=... — activity feed: the latest runs of
// the people the caller follows, newest first. Declared before `/:id` so the
// literal path is not swallowed by the id parameter.
router.get('/feed', authenticateToken, async (req, res) => {
  try {
    const rawLimit = req.query.limit === undefined ? '10' : String(req.query.limit);
    if (!/^\d+$/.test(rawLimit)) {
      throw apiError(400, 'INVALID_LIMIT', 'limit doit être un entier positif.');
    }
    const limit = Math.min(Math.max(Number(rawLimit), 1), 30);

    const following = req.userDB.following || [];
    if (following.length === 0) {
      return res.status(200).json({ items: [], nextCursor: null });
    }

    const filter = { user: { $in: following } };

    if (req.query.cursor !== undefined) {
      const cursor = decodeFeedCursor(String(req.query.cursor));
      // `startedAt` is not unique across users, so the run id breaks ties:
      // without it a page boundary could repeat or skip a run.
      filter.$or = [
        { startedAt: { $lt: cursor.startedAt } },
        { startedAt: cursor.startedAt, _id: { $lt: cursor.id } },
      ];
    }

    // routePoints is deliberately excluded: a feed page would weigh megabytes.
    const runs = await Run.find(filter)
      .select(
        '_id user startedAt durationSeconds distanceMetres averageSpeedMps averagePaceSecondsPerKm caloriesKcal photo.url',
      )
      .sort({ startedAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate('user', 'name pseudo photo city')
      .lean();

    const hasMore = runs.length > limit;
    const page = hasMore ? runs.slice(0, limit) : runs;
    const last = page[page.length - 1];

    const items = page
      // A run whose author was deleted has nothing to display.
      .filter((run) => run.user)
      .map((run) => ({
        id: run._id.toString(),
        startedAt: run.startedAt,
        distanceMetres: run.distanceMetres,
        durationSeconds: run.durationSeconds,
        averagePaceSecondsPerKm: run.averagePaceSecondsPerKm,
        caloriesKcal: run.caloriesKcal,
        photoUrl: run.photo?.url || null,
        author: {
          id: run.user._id.toString(),
          name: run.user.name || '',
          pseudo: run.user.pseudo || '',
          photo: run.user.photo || '',
          city: run.user.city || '',
        },
      }));

    return res.status(200).json({
      items,
      nextCursor: hasMore && last ? encodeFeedCursor(last) : null,
    });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// GET /api/runs/:id — owner only, with the complete route for map replay.
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) {
      throw apiError(400, 'INVALID_RUN_ID', "L'identifiant de la course est invalide.");
    }

    const run = await Run.findOne({
      _id: req.params.id,
      user: req.userDB._id,
    });
    if (!run) {
      throw apiError(404, 'RUN_NOT_FOUND', 'Course introuvable.');
    }

    return res.status(200).json({ run: serializeRun(run) });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// Multer calls next(error) before the controller is reached. Keep those
// responses JSON as well instead of falling through to Express' HTML handler.
router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return sendApiError(res, error);
});

module.exports = router;
module.exports.parseRunPayload = parseRunPayload;
module.exports.serializeRun = serializeRun;
