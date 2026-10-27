/**
 * Simulates a run for a real account, through the real POST /api/runs endpoint,
 * so XP, badges, défis and levels can be checked end to end.
 *
 *   node scripts/simulate-run.js --email you@example.com --km 10 --minutes 20
 *   node scripts/simulate-run.js --email you@example.com --cleanup
 *
 * The run is genuinely written to the database the API is pointed at: it will
 * show up in the app like any other. Use --cleanup to remove everything this
 * script created for that account and roll the XP back.
 *
 * Options:
 *   --email    account to run as (required)
 *   --km       distance in kilometres          (default 10)
 *   --minutes  duration in minutes             (default 20)
 *   --api      API base URL                    (default http://localhost:5001)
 *   --cleanup  delete simulated runs and undo their rewards, then exit
 */

require('dotenv').config();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Run = require('../src/models/Run');
const UserBadge = require('../src/models/UserBadge');
const UserDefi = require('../src/models/UserDefi');
// Registered so `.populate()` can resolve them, even though the script never
// queries these collections directly.
require('../src/models/Badge');
require('../src/models/Defi');
const { getLevelProgress } = require('../src/utils/levels');

const JWT_SECRET = process.env.JWT_SECRET || 'ares_secret_key_2026_super_secure';
/** Marks the runs created here so --cleanup can find them again. */
const SIMULATION_PREFIX = 'simulated-';
const START = { latitude: 36.8065, longitude: 10.1815 }; // Tunis
/** Meridian degree length implied by the Haversine radius the server uses. */
const METRES_PER_DEGREE_LATITUDE = (2 * Math.PI * 6_371_008.8) / 360;

function parseArgs(argv) {
  const args = { km: 10, minutes: 20, api: 'http://localhost:5001', cleanup: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--cleanup') args.cleanup = true;
    else if (key === '--email') args.email = argv[++index];
    else if (key === '--api') args.api = argv[++index];
    else if (key === '--km') args.km = Number(argv[++index]);
    else if (key === '--minutes') args.minutes = Number(argv[++index]);
  }
  return args;
}

/**
 * Straight northbound track. The server recomputes distance from these points
 * with Haversine, so the geometry has to genuinely cover the target distance —
 * declaring it is not enough.
 */
function buildRoutePoints(distanceMetres, durationSeconds, finishedAt) {
  const pointCount = Math.max(2, Math.round(durationSeconds / 5) + 1);
  const startedAtMs = finishedAt.getTime() - durationSeconds * 1000;
  const stepMetres = distanceMetres / (pointCount - 1);
  const stepDegrees = stepMetres / METRES_PER_DEGREE_LATITUDE;
  const speedMps = distanceMetres / durationSeconds;

  return Array.from({ length: pointCount }, (_, index) => ({
    latitude: START.latitude + stepDegrees * index,
    longitude: START.longitude,
    timestamp: startedAtMs + (durationSeconds * 1000 * index) / (pointCount - 1),
    speed: speedMps,
    accuracy: 5,
    altitude: 12,
  }));
}

function describeLevel(xp) {
  const level = getLevelProgress(xp);
  return `niveau ${level.level} (${level.title}) — ${level.xpIntoLevel}/${level.xpForThisLevel} XP`;
}

async function cleanup(user) {
  const runs = await Run.find({
    user: user._id,
    clientRunId: new RegExp(`^${SIMULATION_PREFIX}`),
  }).select('_id clientRunId');

  if (runs.length === 0) {
    console.log('Aucune course simulée à supprimer pour ce compte.');
    return;
  }

  const runIds = runs.map((run) => run._id);
  const runDocs = await Run.find({ _id: { $in: runIds } })
    .select('distanceMetres createdAt')
    .lean();
  // Everything the simulation touched happened at or after its first run.
  const cutoff = runDocs.reduce(
    (earliest, run) => (run.createdAt < earliest ? run.createdAt : earliest),
    runDocs[0].createdAt,
  );

  const badges = await UserBadge.find({ user: user._id, sourceRun: { $in: runIds } })
    .populate('badge', 'label xpReward')
    .lean();

  // A UserDefi row has no source run. Only rows *created* by the simulation can
  // be removed safely; rows that merely had their progress bumped are reported
  // instead of deleted, so real progression is never destroyed.
  const defiQuery = { user: user._id };
  const createdDefis = await UserDefi.find({ ...defiQuery, createdAt: { $gte: cutoff } })
    .populate('defi', 'title xpReward')
    .lean();
  const bumpedDefis = await UserDefi.find({
    ...defiQuery,
    createdAt: { $lt: cutoff },
    updatedAt: { $gte: cutoff },
  })
    .populate('defi', 'title')
    .lean();

  const badgeXp = badges.reduce((sum, entry) => sum + (entry.badge?.xpReward || 0), 0);
  const defiXp = createdDefis
    .filter((entry) => entry.status === 'termine')
    .reduce((sum, entry) => sum + (entry.defi?.xpReward || 0), 0);

  // Mirrors the base award in rewardsService: 10 XP per kilometre.
  const baseXp = runDocs.reduce((sum, run) => sum + Math.floor((run.distanceMetres / 1000) * 10), 0);

  await UserBadge.deleteMany({ user: user._id, sourceRun: { $in: runIds } });
  await UserDefi.deleteMany({ _id: { $in: createdDefis.map((entry) => entry._id) } });
  await Run.deleteMany({ _id: { $in: runIds } });

  const revertedXp = Math.max(0, (user.xp || 0) - baseXp - badgeXp - defiXp);
  user.xp = revertedXp;
  user.level = getLevelProgress(revertedXp).title;
  await user.save();

  console.log(`Courses simulées supprimées : ${runs.length}`);
  console.log(`Badges retirés              : ${badges.length}`);
  console.log(`Défis créés par la simulation, supprimés : ${createdDefis.length}`);
  console.log(`XP : ${revertedXp + baseXp + badgeXp + defiXp} → ${revertedXp}`);
  console.log(`État : ${describeLevel(revertedXp)}`);

  if (bumpedDefis.length > 0) {
    console.log(
      `\n⚠️  ${bumpedDefis.length} défi(s) existaient avant la simulation et ont vu leur progression augmenter.` +
        ' Ils ne sont PAS modifiés, pour ne pas détruire de progression réelle :',
    );
    bumpedDefis.forEach((entry) =>
      console.log(`     - ${entry.defi?.title ?? entry.defi} : ${entry.progressValue} (${entry.status})`),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) {
    console.error('Usage : node scripts/simulate-run.js --email <email> [--km 10] [--minutes 20]');
    process.exit(1);
  }
  if (!Number.isFinite(args.km) || args.km <= 0 || !Number.isFinite(args.minutes) || args.minutes <= 0) {
    console.error('--km et --minutes doivent être des nombres positifs.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: args.email.toLowerCase() });
  if (!user) {
    console.error(`Aucun utilisateur avec l'email ${args.email}.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (args.cleanup) {
    await cleanup(user);
    await mongoose.disconnect();
    return;
  }

  const distanceMetres = args.km * 1000;
  const durationSeconds = Math.round(args.minutes * 60);
  const finishedAt = new Date();
  const startedAt = new Date(finishedAt.getTime() - durationSeconds * 1000);
  const routePoints = buildRoutePoints(distanceMetres, durationSeconds, finishedAt);
  const speedKmh = (distanceMetres / durationSeconds) * 3.6;

  const badgesBefore = await UserBadge.countDocuments({ user: user._id });
  const xpBefore = user.xp || 0;

  console.log(`Compte    : ${user.email} (${user.name || 'sans nom'})`);
  console.log(`Avant     : ${xpBefore} XP — ${describeLevel(xpBefore)}, ${badgesBefore} badge(s)`);
  console.log(
    `Simulation: ${args.km} km en ${args.minutes} min → ${speedKmh.toFixed(1)} km/h, ${routePoints.length} points GPS`,
  );
  if (speedKmh > 25) {
    console.log('  ⚠️  Cette allure dépasse la course à pied : les badges de vitesse se déclencheront.');
  }

  const token = jwt.sign({ id: user._id, email: user.email, role: user.role }, JWT_SECRET, {
    expiresIn: '1h',
  });

  const body = new FormData();
  body.append(
    'run',
    JSON.stringify({
      clientRunId: `${SIMULATION_PREFIX}${crypto.randomUUID()}`,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds,
      routePoints,
    }),
  );

  const response = await fetch(`${args.api}/api/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  const data = await response.json();

  if (!response.ok) {
    console.error(`\nÉCHEC HTTP ${response.status} :`, JSON.stringify(data));
    await mongoose.disconnect();
    process.exit(1);
  }

  const { run, rewards } = data;
  console.log('\n--- COURSE ENREGISTRÉE (métriques recalculées par le serveur) ---');
  console.log(`  distance : ${(run.distanceMetres / 1000).toFixed(2)} km`);
  console.log(`  durée    : ${run.durationSeconds} s`);
  console.log(`  allure   : ${Math.round(run.averagePaceSecondsPerKm)} s/km`);
  console.log(`  calories : ${run.caloriesKcal} kcal`);

  console.log('\n--- RÉCOMPENSES ---');
  console.log(`  XP gagnée : ${rewards.earnedXp}`);
  console.log(`  badges    : ${rewards.unlockedBadges.map((b) => `${b.label} (+${b.xpReward})`).join(', ') || 'aucun'}`);
  console.log(`  défis     : ${rewards.completedDefis.map((d) => `${d.title} (+${d.xpReward})`).join(', ') || 'aucun'}`);

  if (rewards.level) {
    console.log('\n--- NIVEAU ---');
    console.log(`  ${describeLevel(rewards.level.totalXp)}`);
    console.log(
      rewards.levelUp
        ? `  ⬆️  PASSAGE : niveau ${rewards.levelUp.fromLevel} → ${rewards.levelUp.toLevel}` +
            (rewards.levelUp.titleChanged ? ` (${rewards.levelUp.fromTitle} → ${rewards.levelUp.toTitle})` : '')
        : '  pas de passage de niveau avec cette course',
    );
  } else {
    console.log('\n⚠️  Aucune information de niveau dans la réponse : serveur pas à jour ?');
  }

  console.log('\nPour tout annuler : node scripts/simulate-run.js --email ' + args.email + ' --cleanup');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('ERREUR :', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
