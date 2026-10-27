/**
 * Wipes what users have earned, so badge and défi celebrations can be replayed.
 *
 *   node scripts/reset-rewards.js                  # all accounts
 *   node scripts/reset-rewards.js --email a@b.c    # one account
 *   node scripts/reset-rewards.js --xp             # also reset XP and level
 *
 * Only progression is removed: the Badge and Defi catalogues built from the
 * admin panel are never touched, otherwise there would be nothing left to earn.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/User');
const UserBadge = require('../src/models/UserBadge');
const UserDefi = require('../src/models/UserDefi');
const { getLevelProgress } = require('../src/utils/levels');

function parseArgs(argv) {
  const args = { resetXp: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--xp') args.resetXp = true;
    else if (argv[index] === '--email') args.email = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI);

  let scope = {};
  if (args.email) {
    const user = await User.findOne({ email: args.email.toLowerCase() }).select('_id email');
    if (!user) {
      console.error(`Aucun utilisateur avec l'email ${args.email}.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    scope = { user: user._id };
    console.log(`Portée : ${user.email}`);
  } else {
    console.log('Portée : tous les comptes');
  }

  const badgeCount = await UserBadge.countDocuments(scope);
  const defiCount = await UserDefi.countDocuments(scope);

  await UserBadge.deleteMany(scope);
  await UserDefi.deleteMany(scope);

  console.log(`Badges gagnés supprimés      : ${badgeCount}`);
  console.log(`Progressions de défis effacées : ${defiCount}`);

  if (args.resetXp) {
    const userScope = args.email ? { _id: scope.user } : { role: 'user' };
    const result = await User.updateMany(userScope, {
      $set: { xp: 0, level: getLevelProgress(0).title },
    });
    console.log(`XP et niveau remis à zéro     : ${result.modifiedCount} compte(s)`);
  } else {
    console.log("XP et niveaux : inchangés (utiliser --xp pour les remettre à zéro).");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('ERREUR :', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
