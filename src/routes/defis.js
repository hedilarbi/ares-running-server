const express = require('express');
const router = express.Router();
const Defi = require('../models/Defi');
const UserDefi = require('../models/UserDefi');
const { authenticateToken } = require('../middleware/auth');
const { APP_TIMEZONE, daysLeftInPeriod, getPeriodId } = require('../utils/time');

// Helper to format the subtitle based on goal type and progress
const oneDecimal = (value) => (Math.floor(value * 10) / 10).toLocaleString('fr-FR');

function formatSub(goalType, progressValue, goalValue) {
  if (goalType === 'distance') {
    // Rounded down: 4.96 km must not read as a finished 5 km.
    return `${oneDecimal(progressValue / 1000)} / ${oneDecimal(goalValue / 1000)} km`;
  } else if (goalType === 'nb_courses') {
    return `${progressValue} / ${goalValue} courses`;
  } else if (goalType === 'vitesse') {
    // Stored in m/s, shown in km/h.
    return `${oneDecimal(progressValue * 3.6)} / ${oneDecimal(goalValue * 3.6)} km/h`;
  }
  return `${progressValue} / ${goalValue}`;
}

function formatDaysLeft(now, period) {
  const days = daysLeftInPeriod(now, period);
  if (days === 0) return "Dernier jour";
  return `${days} j restant${days > 1 ? 's' : ''}`;
}

// Helper to format kind
function formatKind(kind) {
  if (kind === 'amis') return 'Entre amis';
  if (kind === 'clubs') return 'Entre clubs';
  return 'Individuel';
}

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();

    const activeDefis = await Defi.find({ isActive: true });
    
    // Fetch all user defis to find completed ones, and current ones
    const userDefis = await UserDefi.find({ user: userId }).populate('defi');

    const termines = [];
    const encours = [];
    const dispo = [];

    // Map userDefis by defi ID and period ID for quick lookup
    const udMap = {};
    for (const ud of userDefis) {
      // populate can result in null if defi was deleted, filter those out
      if (!ud.defi) continue;
      
      const key = `${ud.defi._id.toString()}_${ud.periodId}`;
      udMap[key] = ud;
      
      if (ud.status === 'termine') {
        const completedDate = new Date(ud.completedAt || ud.updatedAt);
        const options = { day: 'numeric', month: 'short', timeZone: APP_TIMEZONE };
        termines.push({
          // A daily défi is completed once per period: the défi id alone repeats.
          id: `${ud.defi._id.toString()}_${ud.periodId}`,
          _id: ud.defi._id,
          title: ud.defi.title,
          sub: `Terminé le ${completedDate.toLocaleDateString('fr-FR', options)}`,
          pct: '100%',
          right: '✓ Réussi',
          kind: formatKind(ud.defi.kind)
        });
      }
    }

    for (const defi of activeDefis) {
      const currentPeriodId = getPeriodId(now, defi.period);
      const key = `${defi._id.toString()}_${currentPeriodId}`;
      const ud = udMap[key];

      if (ud) {
        if (ud.status === 'en_cours') {
          const pctVal = defi.goalValue > 0
            ? Math.min(100, Math.floor((ud.progressValue / defi.goalValue) * 100))
            : 0;

          encours.push({
            id: key,
            _id: defi._id,
            title: defi.title,
            sub: formatSub(defi.goalType, ud.progressValue, defi.goalValue),
            pct: `${pctVal}%`,
            right: formatDaysLeft(now, defi.period),
            kind: formatKind(defi.kind)
          });
        }
      } else {
        // No user defi for the CURRENT period -> available
        dispo.push({
          id: key,
          _id: defi._id,
          title: defi.title,
          sub: `Récompense · ${defi.xpReward} XP`,
          pct: '0%',
          right: 'Rejoindre',
          kind: formatKind(defi.kind)
        });
      }
    }

    res.status(200).json({
      encours,
      dispo,
      termines
    });

  } catch (error) {
    console.error('Error fetching defis:', error);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/:id/join', async (req, res) => {
  try {
    const defiId = req.params.id;
    const userId = req.user.id;
    const now = new Date();

    const defi = await Defi.findById(defiId);
    if (!defi || !defi.isActive) {
      return res.status(404).json({ error: 'Défi introuvable ou inactif.' });
    }

    const currentPeriodId = getPeriodId(now, defi.period);

    let ud = await UserDefi.findOne({ user: userId, defi: defiId, periodId: currentPeriodId });
    if (!ud) {
      ud = await UserDefi.create({
        user: userId,
        defi: defiId,
        periodId: currentPeriodId,
        progressValue: 0,
        status: 'en_cours'
      });
    }

    res.status(200).json({ message: 'Défi rejoint avec succès', userDefi: ud });
  } catch (error) {
    console.error('Error joining defi:', error);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
