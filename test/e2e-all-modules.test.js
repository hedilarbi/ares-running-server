const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Register all models
const User = require('../src/models/User');
const Run = require('../src/models/Run');
const RunComment = require('../src/models/RunComment');
const Badge = require('../src/models/Badge');
const UserBadge = require('../src/models/UserBadge');
const Defi = require('../src/models/Defi');
const UserDefi = require('../src/models/UserDefi');
const Group = require('../src/models/Group');
const GroupMember = require('../src/models/GroupMember');
const GroupRunContribution = require('../src/models/GroupRunContribution');
const GroupPost = require('../src/models/GroupPost');
const GroupPostComment = require('../src/models/GroupPostComment');
const GroupChallenge = require('../src/models/GroupChallenge');
const GroupChallengeParticipant = require('../src/models/GroupChallengeParticipant');
const GroupReport = require('../src/models/GroupReport');

const connectDB = require('../src/db');
const authRoutes = require('../src/routes/auth');
const adminRoutes = require('../src/routes/admin');
const userRoutes = require('../src/routes/user');
const runRoutes = require('../src/routes/runs');
const defiRoutes = require('../src/routes/defis');
const groupRoutes = require('../src/routes/groups');

const TEST_TAG = `e2e_${Date.now()}`;
const EMAIL_A = `runner.a.${TEST_TAG}@ares-test.tn`;
const EMAIL_B = `runner.b.${TEST_TAG}@ares-test.tn`;
const EMAIL_C = `runner.c.${TEST_TAG}@ares-test.tn`;
const EMAIL_ADMIN = `admin.${TEST_TAG}@ares-test.tn`;

/**
 * Generates a realistic GPS trace along the equator where 1 degree of longitude
 * is ~111,195 metres. Each step is ~100m over 25 seconds (4 m/s = 14.4 km/h).
 */
function buildGpsRoute(distanceMetres, startedAtMs) {
  const stepMetres = 100;
  const numSteps = Math.max(1, Math.round(distanceMetres / stepMetres));
  const degPerMetre = 1 / 111194.92664455873;
  const points = [];
  for (let i = 0; i <= numSteps; i++) {
    points.push({
      latitude: 36.8065,
      longitude: 10.1815 + (i * stepMetres * degPerMetre) / Math.cos((36.8065 * Math.PI) / 180),
      timestamp: startedAtMs + i * 25 * 1000,
      speed: 4.0,
      accuracy: 5,
      altitude: 12,
    });
  }
  return {
    routePoints: points,
    durationSeconds: numSteps * 25,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(startedAtMs + numSteps * 25 * 1000).toISOString(),
  };
}

async function postRunMultipart(baseUrl, token, runPayload) {
  const form = new FormData();
  form.append('run', JSON.stringify(runPayload));
  const res = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('E2E complet : Auth, Courses, Social/Feed, Groupes, Classements, Défis & Badges, Admin', async (t) => {
  await connectDB();

  const app = express();
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/runs', runRoutes);
  app.use('/api/defis', defiRoutes);
  app.use('/api/groups', groupRoutes);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const BASE_URL = `http://127.0.0.1:${port}`;

  const createdUserIds = [];
  const createdGroupIds = [];
  let createdBadgeId = null;
  let createdDefiId = null;

  const jsonReq = async (method, urlPath, token, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  try {
    // =========================================================================
    // MODULE 1 : INSCRIPTION, OTP, CONNEXION, PROFIL SETUP & MOT DE PASSE OUBLIÉ
    // =========================================================================
    let tokenA, tokenB, tokenC, tokenAdmin;
    let userAId, userBId, userCId;

    await t.test('1. Module Auth : Inscription, OTP, Connexion, Profil Setup & Mot de passe oublié', async () => {
      // 1.1 Register Runner A, Runner B, Runner C, and Admin
      for (const email of [EMAIL_A, EMAIL_B, EMAIL_C, EMAIL_ADMIN]) {
        const reg = await jsonReq('POST', '/api/auth/register', null, {
          email,
          password: 'InitialPassword123!',
        });
        assert.equal(reg.status, 201, `Inscription de ${email} doit retourner 201`);
      }

      // 1.2 Login before OTP verification must return 403 needsVerification
      const unverifiedLogin = await jsonReq('POST', '/api/auth/login', null, {
        email: EMAIL_A,
        password: 'InitialPassword123!',
      });
      assert.equal(unverifiedLogin.status, 403);
      assert.equal(unverifiedLogin.data.needsVerification, true);

      // 1.3 Verify OTP for all 4 accounts
      const verifyAccount = async (email) => {
        const dbUser = await User.findOne({ email });
        assert.ok(dbUser && dbUser.otpCode, `Code OTP présent en base pour ${email}`);
        createdUserIds.push(dbUser._id);
        const ver = await jsonReq('POST', '/api/auth/verify-otp', null, {
          email,
          otpCode: dbUser.otpCode,
        });
        assert.equal(ver.status, 200);
        assert.ok(ver.data.token);
        return { token: ver.data.token, id: ver.data.user.id };
      };

      const resA = await verifyAccount(EMAIL_A);
      const resB = await verifyAccount(EMAIL_B);
      const resC = await verifyAccount(EMAIL_C);
      const resAdm = await verifyAccount(EMAIL_ADMIN);

      tokenA = resA.token;
      userAId = resA.id;
      tokenB = resB.token;
      userBId = resB.id;
      tokenC = resC.token;
      userCId = resC.id;

      // Elevate admin user role to 'admin'
      await User.updateOne({ _id: resAdm.id }, { $set: { role: 'admin', name: 'Super Admin' } });
      const admLogin = await jsonReq('POST', '/api/admin/login', null, {
        email: EMAIL_ADMIN,
        password: 'InitialPassword123!',
      });
      assert.equal(admLogin.status, 200);
      tokenAdmin = admLogin.data.token;

      // 1.4 Forgot Password & Reset Password workflow on Runner A
      const forgotRes = await jsonReq('POST', '/api/auth/forgot-password', null, {
        email: EMAIL_A,
      });
      assert.equal(forgotRes.status, 200);

      const userAWithResetOtp = await User.findOne({ email: EMAIL_A });
      assert.ok(userAWithResetOtp.otpCode, 'OTP de réinitialisation généré');

      // Wrong OTP must fail
      const badReset = await jsonReq('POST', '/api/auth/reset-password', null, {
        email: EMAIL_A,
        otpCode: '000000',
        newPassword: 'NewStrongPassword456!',
      });
      assert.equal(badReset.status, 400);

      // Valid OTP resets password
      const goodReset = await jsonReq('POST', '/api/auth/reset-password', null, {
        email: EMAIL_A,
        otpCode: userAWithResetOtp.otpCode,
        newPassword: 'NewStrongPassword456!',
      });
      assert.equal(goodReset.status, 200);

      // Old password must fail (401), new password must succeed (200)
      const oldPwdLogin = await jsonReq('POST', '/api/auth/login', null, {
        email: EMAIL_A,
        password: 'InitialPassword123!',
      });
      assert.equal(oldPwdLogin.status, 401);

      const newPwdLogin = await jsonReq('POST', '/api/auth/login', null, {
        email: EMAIL_A,
        password: 'NewStrongPassword456!',
      });
      assert.equal(newPwdLogin.status, 200);
      tokenA = newPwdLogin.data.token;

      // 1.5 Profile Setup for Runner A, B, C
      const setupA = await jsonReq('PUT', '/api/auth/profile-setup', tokenA, {
        name: 'Amine Ben Ali',
        pseudo: `amine_${TEST_TAG}`,
        sex: 'Homme',
        dateOfBirth: '1995-05-12',
        height: 180,
        weight: 74,
        city: 'La Marsa',
        governorate: 'Tunis',
        country: 'Tunisie',
      });
      assert.equal(setupA.status, 200);
      assert.equal(setupA.data.user.city, 'La Marsa');

      const setupB = await jsonReq('PUT', '/api/auth/profile-setup', tokenB, {
        name: 'Sarra Trabelsi',
        pseudo: `sarra_${TEST_TAG}`,
        sex: 'Femme',
        dateOfBirth: '1998-09-20',
        height: 168,
        weight: 60,
        city: 'La Marsa',
        governorate: 'Tunis',
        country: 'Tunisie',
      });
      assert.equal(setupB.status, 200);

      const setupC = await jsonReq('PUT', '/api/auth/profile-setup', tokenC, {
        name: 'Yassine Khelifi',
        pseudo: `yassine_${TEST_TAG}`,
        sex: 'Homme',
        dateOfBirth: '1993-02-10',
        height: 175,
        weight: 70,
        city: 'Sousse Médina',
        governorate: 'Sousse',
        country: 'Tunisie',
      });
      assert.equal(setupC.status, 200);

      // Duplicate pseudo check
      const dupPseudo = await jsonReq('PUT', '/api/auth/profile-setup', tokenC, {
        pseudo: `amine_${TEST_TAG}`,
      });
      assert.equal(dupPseudo.status, 400);

      // GET /api/auth/me
      const meRes = await jsonReq('GET', '/api/auth/me', tokenA);
      assert.equal(meRes.status, 200);
      assert.equal(meRes.data.user.pseudo, `amine_${TEST_TAG}`);
    });

    // =========================================================================
    // MODULE 2 : DÉFIS & BADGES PLATEFORME (Création, Inscription & Catalogue)
    // =========================================================================
    await t.test('2. Module Défis & Badges : Catalogue et Inscription', async () => {
      const badge = await Badge.create({
        key: `badge_5k_${TEST_TAG}`,
        label: `Explorateur 5K (${TEST_TAG})`,
        description: 'Courir au moins 4 km en une sortie',
        category: 'distance',
        criteriaType: 'distance_course',
        criteriaThreshold: 4000,
        xpReward: 150,
        isActive: true,
        image: {
          url: 'https://example.com/badge.png',
          path: `badges/test-${TEST_TAG}.png`,
          metadata: { contentType: 'image/png', sizeBytes: 1024, width: 128, height: 128 },
        },
      });
      createdBadgeId = badge._id;

      const defi = await Defi.create({
        title: `Défi 5K Hebdo (${TEST_TAG})`,
        description: 'Atteindre 5 km cette semaine',
        kind: 'individuel',
        goalType: 'distance',
        goalValue: 5000,
        period: 'hebdomadaire',
        xpReward: 200,
        isActive: true,
        image: {
          url: 'https://example.com/defi.png',
          path: `defis/test-${TEST_TAG}.png`,
          metadata: { contentType: 'image/png', sizeBytes: 1024, width: 128, height: 128 },
        },
      });
      createdDefiId = defi._id;

      // Runner B checks available defis
      const defisBefore = await jsonReq('GET', '/api/defis', tokenB);
      assert.equal(defisBefore.status, 200);
      assert.ok(
        defisBefore.data.dispo.some((d) => String(d._id) === String(createdDefiId)),
        'Le nouveau défi doit apparaître dans les défis disponibles',
      );

      // Runner B joins the defi
      const joinRes = await jsonReq('POST', `/api/defis/${createdDefiId}/join`, tokenB);
      assert.equal(joinRes.status, 200);

      const defisAfterJoin = await jsonReq('GET', '/api/defis', tokenB);
      assert.ok(
        defisAfterJoin.data.encours.some((d) => String(d._id) === String(createdDefiId)),
        'Le défi rejoint doit apparaître dans encours',
      );

      // Runner B checks badge catalog before run
      const badgesBefore = await jsonReq('GET', '/api/users/me/badges', tokenB);
      assert.equal(badgesBefore.status, 200);
      const targetBadge = badgesBefore.data.badges.find((b) => b.key === `badge_5k_${TEST_TAG}`);
      assert.ok(targetBadge);
      assert.equal(targetBadge.unlocked, false);
    });

    // =========================================================================
    // MODULE 3 : GROUPES (Création, Recherche, Public/Privé, Demandes, Invitations, Défis)
    // =========================================================================
    let group1Id, group2PrivateId, group3SousseId;
    let indivChallengeId, collectChallengeId;

    await t.test('3. Module Groupes : Création, Recherche, Adhésion Public/Privé, Invitations & Défis', async () => {
      // 3.1 Runner A creates Group 1 (Public Running Club in La Marsa, Tunis)
      const g1 = await jsonReq('POST', '/api/groups', tokenA, {
        name: `ARES Runners Marsa ${TEST_TAG}`,
        description: 'Club officiel de La Marsa',
        type: 'club',
        city: 'La Marsa',
        governorate: 'Tunis',
        privacy: 'public',
      });
      assert.equal(g1.status, 201);
      group1Id = g1.data.group.id;
      createdGroupIds.push(group1Id);
      assert.equal(g1.data.group.myRole, 'admin');
      assert.equal(g1.data.group.memberCount, 1);

      // 3.2 Runner A creates Group 2 (Private Friends Group in La Marsa, Tunis)
      const g2 = await jsonReq('POST', '/api/groups', tokenA, {
        name: `Squad Privé Marsa ${TEST_TAG}`,
        description: 'Groupe privé entre amis',
        type: 'amis',
        city: 'La Marsa',
        governorate: 'Tunis',
        privacy: 'private',
      });
      assert.equal(g2.status, 201);
      group2PrivateId = g2.data.group.id;
      createdGroupIds.push(group2PrivateId);

      // 3.3 Runner C creates Group 3 (Public Club in Sousse Médina, Sousse)
      const g3 = await jsonReq('POST', '/api/groups', tokenC, {
        name: `Sousse Coast Club ${TEST_TAG}`,
        description: 'Club de Sousse',
        type: 'club',
        city: 'Sousse Médina',
        governorate: 'Sousse',
        privacy: 'public',
      });
      assert.equal(g3.status, 201);
      group3SousseId = g3.data.group.id;
      createdGroupIds.push(group3SousseId);

      // 3.4 Search groups by name, city, governorate
      const searchByName = await jsonReq(
        'GET',
        `/api/groups?q=${encodeURIComponent(TEST_TAG)}&governorate=Tunis`,
        tokenB,
      );
      assert.equal(searchByName.status, 200);
      assert.equal(searchByName.data.groups.length, 2);

      // 3.5 Runner B requests to join Public Group 1 & Public Group 3 -> pending_request, admin accepts
      const joinG1 = await jsonReq('POST', `/api/groups/${group1Id}/join`, tokenB);
      assert.equal(joinG1.status, 200);
      assert.equal(joinG1.data.status, 'pending_request');
      const acceptB1 = await jsonReq(
        'PATCH',
        `/api/groups/${group1Id}/members/${userBId}`,
        tokenA,
        { action: 'accept' },
      );
      assert.equal(acceptB1.status, 200);
      assert.equal(acceptB1.data.memberCount, 2);

      const joinG3 = await jsonReq('POST', `/api/groups/${group3SousseId}/join`, tokenB);
      assert.equal(joinG3.status, 200);
      assert.equal(joinG3.data.status, 'pending_request');
      const acceptB3 = await jsonReq(
        'PATCH',
        `/api/groups/${group3SousseId}/members/${userBId}`,
        tokenC,
        { action: 'accept' },
      );
      assert.equal(acceptB3.status, 200);

      // 3.6 Runner B requests to join Private Group 2 -> pending_request
      const joinG2 = await jsonReq('POST', `/api/groups/${group2PrivateId}/join`, tokenB);
      assert.equal(joinG2.status, 200);
      assert.equal(joinG2.data.status, 'pending_request');

      // While pending, Runner B cannot access private group feed or leaderboard (Section 9)
      const privateFeedDenied = await jsonReq('GET', `/api/groups/${group2PrivateId}/feed`, tokenB);
      assert.equal(privateFeedDenied.status, 403);
      const privateLbDenied = await jsonReq('GET', `/api/groups/${group2PrivateId}/leaderboard`, tokenB);
      assert.equal(privateLbDenied.status, 403);

      // Runner A (admin of Group 2) sees pending request and accepts Runner B
      const membersG2Before = await jsonReq('GET', `/api/groups/${group2PrivateId}/members`, tokenA);
      assert.equal(membersG2Before.status, 200);
      assert.equal(membersG2Before.data.pendingRequests.length, 1);
      assert.equal(membersG2Before.data.pendingRequests[0].id, userBId);

      const acceptB = await jsonReq(
        'PATCH',
        `/api/groups/${group2PrivateId}/members/${userBId}`,
        tokenA,
        { action: 'accept' },
      );
      assert.equal(acceptB.status, 200);
      assert.equal(acceptB.data.memberCount, 2);

      // Runner A invites Runner C to Private Group 2, and Runner C accepts
      const inviteC = await jsonReq('POST', `/api/groups/${group2PrivateId}/invite`, tokenA, {
        userId: userCId,
      });
      assert.equal(inviteC.status, 201);
      assert.equal(inviteC.data.status, 'invited');

      const acceptInviteC = await jsonReq('POST', `/api/groups/${group2PrivateId}/join`, tokenC);
      assert.equal(acceptInviteC.status, 200);
      assert.equal(acceptInviteC.data.status, 'active');
      assert.equal(acceptInviteC.data.memberCount, 3);

      // 3.7 Runner A creates an individual challenge (30 km) and a collective challenge (10 km) in Group 1
      const now = Date.now();
      const chIndiv = await jsonReq('POST', `/api/groups/${group1Id}/challenges`, tokenA, {
        title: '30 km en une semaine',
        description: 'Défi individuel hebdomadaire',
        mode: 'individuel',
        goalType: 'distance',
        goalValue: 30000,
        startDate: new Date(now - 60_000).toISOString(),
        endDate: new Date(now + 7 * 86400_000).toISOString(),
      });
      assert.equal(chIndiv.status, 201);
      indivChallengeId = chIndiv.data.challenge._id;

      const chCollect = await jsonReq('POST', `/api/groups/${group1Id}/challenges`, tokenA, {
        title: '10 km collectifs',
        description: 'Objectif collectif du club',
        mode: 'collectif',
        goalType: 'distance',
        goalValue: 10000,
        startDate: new Date(now - 60_000).toISOString(),
        endDate: new Date(now + 30 * 86400_000).toISOString(),
      });
      assert.equal(chCollect.status, 201);
      collectChallengeId = chCollect.data.challenge._id;

      // Runner B freely joins both group challenges
      const joinCh1 = await jsonReq(
        'POST',
        `/api/groups/${group1Id}/challenges/${indivChallengeId}/join`,
        tokenB,
      );
      assert.equal(joinCh1.status, 200);

      const joinCh2 = await jsonReq(
        'POST',
        `/api/groups/${group1Id}/challenges/${collectChallengeId}/join`,
        tokenB,
      );
      assert.equal(joinCh2.status, 200);
    });

    // =========================================================================
    // MODULE 4 : CRÉATION DE COURSE, COMPTABILISATION MULTI-GROUPES & PARTAGE
    // =========================================================================
    let runB1Id, runB2Id, runA1Id;

    await t.test('4. Module Course & Partage : Une seule course, plusieurs contributions sans duplication', async () => {
      // Runner B is an active member of 3 groups (Group 1, Group 2, Group 3)
      // Runner B records a 5.2 km run (finishing right now, after challenge enrollment)
      const startedAtB1 = Date.now() - 1300_000;
      const gpsB1 = buildGpsRoute(5200, startedAtB1);
      const clientRunIdB1 = `run-b1-${TEST_TAG}`;

      const saveRunB1 = await postRunMultipart(BASE_URL, tokenB, {
        clientRunId: clientRunIdB1,
        ...gpsB1,
        description: 'Sortie matinale 5,2 km au bord de mer !',
      });
      assert.equal(saveRunB1.status, 201);
      runB1Id = saveRunB1.data.run.id;
      const actualDistanceB1 = saveRunB1.data.run.distanceMetres;
      assert.ok(actualDistanceB1 >= 5000 && actualDistanceB1 <= 5400);

      // 4.1 Test idempotence: uploading the same clientRunId again does not duplicate
      const retryRunB1 = await postRunMultipart(BASE_URL, tokenB, {
        clientRunId: clientRunIdB1,
        ...gpsB1,
        description: 'Sortie matinale 5,2 km au bord de mer !',
      });
      assert.equal(retryRunB1.status, 200);
      assert.equal(retryRunB1.data.idempotent, true);

      // 4.2 Verify personal stats: NEVER multiplied in personal profile (Section 4 & 10)
      const statsB = await jsonReq('GET', '/api/runs/me/stats', tokenB);
      assert.equal(statsB.status, 200);
      assert.equal(statsB.data.stats.runCount, 1, 'Le profil personnel ne compte qu’une seule course');
      assert.equal(
        Math.round(statsB.data.stats.distanceMetres),
        Math.round(actualDistanceB1),
        'Les kilomètres personnels ne sont jamais multipliés par le nombre de groupes',
      );

      // 4.3 Verify each of the 3 groups received the ~5.2 km contribution exactly once
      for (const gId of [group1Id, group2PrivateId, group3SousseId]) {
        const gRes = await jsonReq('GET', `/api/groups/${gId}`, tokenB);
        assert.equal(gRes.status, 200);
        assert.equal(
          Math.round(gRes.data.group.totalDistanceMetres),
          Math.round(actualDistanceB1),
          `Le groupe ${gId} a reçu exactement 1 contribution de la course`,
        );
      }

      // 4.4 Verify Badge & Platform Defi were automatically unlocked/completed by this run
      const badgesAfter = await jsonReq('GET', '/api/users/me/badges', tokenB);
      const unlockedBadge = badgesAfter.data.badges.find((b) => b.key === `badge_5k_${TEST_TAG}`);
      assert.equal(unlockedBadge.unlocked, true, 'Le badge 4K+ est débloqué');

      const defisAfter = await jsonReq('GET', '/api/defis', tokenB);
      assert.ok(
        defisAfter.data.termines.some((d) => String(d._id) === String(createdDefiId)),
        'Le défi hebdomadaire 5K est passé dans terminés',
      );

      // 4.5 Verify Group Challenges progressed automatically
      const g1ChallengesAfterB = await jsonReq('GET', `/api/groups/${group1Id}/challenges`, tokenB);
      assert.equal(g1ChallengesAfterB.status, 200);
      const indivCh = g1ChallengesAfterB.data.enCours.find((c) => c.id === String(indivChallengeId));
      const collectCh = g1ChallengesAfterB.data.enCours.find((c) => c.id === String(collectChallengeId));
      assert.ok(indivCh);
      assert.equal(Math.round(indivCh.myProgressValue), Math.round(actualDistanceB1));
      assert.ok(collectCh);
      assert.equal(Math.round(collectCh.collectiveProgressValue), Math.round(actualDistanceB1));

      // Runner A also runs 5.2 km -> completes the 10 km collective challenge!
      const gpsA1 = buildGpsRoute(5200, Date.now() - 1300_000);
      const saveRunA1 = await postRunMultipart(BASE_URL, tokenA, {
        clientRunId: `run-a1-${TEST_TAG}`,
        ...gpsA1,
        description: 'Contribution au défi collectif !',
      });
      assert.equal(saveRunA1.status, 201);
      runA1Id = saveRunA1.data.run.id;

      const g1ChallengesAfterA = await jsonReq('GET', `/api/groups/${group1Id}/challenges`, tokenA);
      const collectChAfter = g1ChallengesAfterA.data.enCours.find(
        (c) => c.id === String(collectChallengeId),
      );
      assert.equal(collectChAfter.pct, 100, 'Le défi collectif de 10 km a atteint 100%');
      assert.equal(collectChAfter.status, 'termine');

      // 4.6 Verify Privacy Setting `autoContributeKm = false` (Section 4)
      const disableAutoKm = await jsonReq(
        'PATCH',
        `/api/groups/${group3SousseId}/my-settings`,
        tokenB,
        { autoContributeKm: false },
      );
      assert.equal(disableAutoKm.status, 200);
      assert.equal(disableAutoKm.data.autoContributeKm, false);

      // Runner B records a 2nd run of 2 km (on a previous day to also test regularity = 2 days!)
      const yesterdayMs = Date.now() - 26 * 3600_000;
      const gpsB2 = buildGpsRoute(2000, yesterdayMs);
      const saveRunB2 = await postRunMultipart(BASE_URL, tokenB, {
        clientRunId: `run-b2-${TEST_TAG}`,
        ...gpsB2,
        description: 'Footing récupération 2 km',
      });
      assert.equal(saveRunB2.status, 201);
      runB2Id = saveRunB2.data.run.id;
      const distB2 = saveRunB2.data.run.distanceMetres;

      // Group 1 received Run B2, while Group 3 (where autoContributeKm=false) did NOT!
      const g1Check = await jsonReq('GET', `/api/groups/${group1Id}`, tokenB);
      const g3Check = await jsonReq('GET', `/api/groups/${group3SousseId}`, tokenB);
      assert.ok(g1Check.data.group.totalDistanceMetres > actualDistanceB1 + distB2);
      assert.equal(
        Math.round(g3Check.data.group.totalDistanceMetres),
        Math.round(actualDistanceB1),
        'Group 3 ne doit pas recevoir la course quand autoContributeKm est désactivé',
      );

      // 4.7 Voluntary Sharing to Group Feed (Section 5)
      // Feed is empty before voluntary sharing
      const feedBeforeShare = await jsonReq('GET', `/api/groups/${group1Id}/feed`, tokenB);
      assert.equal(feedBeforeShare.data.items.length, 0, 'Aucune publication automatique dans le fil du groupe');

      // Runner B voluntarily shares Run B1 to Group 1 and Group 2
      const shareRes = await jsonReq('POST', '/api/groups/share-run', tokenB, {
        runId: runB1Id,
        groupIds: [group1Id, group2PrivateId],
        caption: 'Super séance partagée avec le groupe ! 💪',
      });
      assert.equal(shareRes.status, 201);
      assert.equal(shareRes.data.sharedGroupIds.length, 2);

      const feedAfterShare = await jsonReq('GET', `/api/groups/${group1Id}/feed`, tokenA);
      assert.equal(feedAfterShare.status, 200);
      assert.equal(feedAfterShare.data.items.length, 1);
      const sharedPost = feedAfterShare.data.items[0];
      assert.equal(sharedPost.caption, 'Super séance partagée avec le groupe ! 💪');
      assert.equal(
        sharedPost.run.routePoints,
        undefined,
        "L'itinéraire GPS détaillé (routePoints) est masqué par défaut dans le fil du groupe",
      );

      // Like, comment, and report on the group post
      const likePost = await jsonReq(
        'POST',
        `/api/groups/${group1Id}/posts/${sharedPost.id}/like`,
        tokenA,
      );
      assert.equal(likePost.status, 200);
      assert.equal(likePost.data.likeCount, 1);

      const commentPost = await jsonReq(
        'POST',
        `/api/groups/${group1Id}/posts/${sharedPost.id}/comments`,
        tokenA,
        { text: 'Bravo Sarra pour ce chrono !' },
      );
      assert.equal(commentPost.status, 201);

      const listPostComments = await jsonReq(
        'GET',
        `/api/groups/${group1Id}/posts/${sharedPost.id}/comments`,
        tokenB,
      );
      assert.equal(listPostComments.data.comments.length, 1);

      const reportPost = await jsonReq(
        'POST',
        `/api/groups/${group1Id}/posts/${sharedPost.id}/report`,
        tokenC,
        { reason: 'Test signalement modération' },
      );
      assert.equal(reportPost.status, 201);
    });

    // =========================================================================
    // MODULE 5 : SOCIAL, FEED ACCUEIL, SCROLL (CURSEUR) & ABONNEMENTS
    // =========================================================================
    await t.test('5. Module Social : Suggestions, Abonnements, Feed Accueil & Pagination Scroll', async () => {
      // 5.1 User suggestions & search
      const suggestionsRes = await jsonReq('GET', '/api/users/suggestions', tokenA);
      assert.equal(suggestionsRes.status, 200);
      assert.ok(Array.isArray(suggestionsRes.data.suggestions));

      const searchUsers = await jsonReq(
        'GET',
        `/api/users/search?q=${encodeURIComponent(`sarra_${TEST_TAG}`)}`,
        tokenA,
      );
      assert.equal(searchUsers.status, 200);
      assert.equal(searchUsers.data.users.length, 1);
      assert.equal(searchUsers.data.users[0]._id, userBId);

      // 5.2 Follow Runner B from Runner A
      const followRes = await jsonReq('POST', `/api/users/${userBId}/follow`, tokenA);
      assert.equal(followRes.status, 200);
      assert.equal(followRes.data.isFollowing, true);

      const followersB = await jsonReq('GET', `/api/users/${userBId}/followers`, tokenA);
      assert.equal(followersB.status, 200);
      assert.ok(followersB.data.users.some((u) => u.id === userAId));

      const followingA = await jsonReq('GET', `/api/users/${userAId}/following`, tokenA);
      assert.equal(followingA.status, 200);
      assert.ok(followingA.data.users.some((u) => u.id === userBId));

      // 5.3 Home Feed & Keyset Cursor Pagination (Scroll)
      // Runner A's feed contains Runner A's run (1) + Runner B's runs (2) = 3 runs total
      const feedPage1 = await jsonReq('GET', '/api/runs/feed?limit=2', tokenA);
      assert.equal(feedPage1.status, 200);
      assert.equal(feedPage1.data.items.length, 2);
      assert.ok(feedPage1.data.nextCursor, 'nextCursor présent pour le scroll infini');

      const feedPage2 = await jsonReq(
        'GET',
        `/api/runs/feed?limit=2&cursor=${encodeURIComponent(feedPage1.data.nextCursor)}`,
        tokenA,
      );
      assert.equal(feedPage2.status, 200);
      assert.ok(feedPage2.data.items.length >= 1);
      const page1Ids = new Set(feedPage1.data.items.map((i) => i.id));
      for (const item of feedPage2.data.items) {
        assert.ok(!page1Ids.has(item.id), 'Aucun doublon entre la page 1 et la page 2 du scroll');
      }

      // 5.4 Like, Comment & Edit Caption on Feed Run
      const likeRun = await jsonReq('POST', `/api/runs/${runB1Id}/like`, tokenA);
      assert.equal(likeRun.status, 200);
      assert.equal(likeRun.data.liked, true);
      assert.equal(likeRun.data.likeCount, 1);

      const likesList = await jsonReq('GET', `/api/runs/${runB1Id}/likes`, tokenA);
      assert.equal(likesList.status, 200);
      assert.equal(likesList.data.users.length, 1);

      const addComment = await jsonReq('POST', `/api/runs/${runB1Id}/comments`, tokenA, {
        text: 'Super allure sur le feed principal !',
      });
      assert.equal(addComment.status, 201);
      const commentId = addComment.data.comment.id;

      const getComments = await jsonReq('GET', `/api/runs/${runB1Id}/comments`, tokenA);
      assert.equal(getComments.status, 200);
      assert.equal(getComments.data.comments.length, 1);

      const delComment = await jsonReq(
        'DELETE',
        `/api/runs/${runB1Id}/comments/${commentId}`,
        tokenA,
      );
      assert.equal(delComment.status, 200);

      const editCaption = await jsonReq('PATCH', `/api/runs/${runB1Id}`, tokenB, {
        description: 'Sortie 5,2 km mise à jour !',
      });
      assert.equal(editCaption.status, 200);
      assert.equal(editCaption.data.run.description, 'Sortie 5,2 km mise à jour !');
    });

    // =========================================================================
    // MODULE 6 : CLASSEMENTS (Coureurs, Interne au Groupe, Inter-Groupes) & ADMIN / SUPPRESSION
    // =========================================================================
    await t.test('6. Module Classements, Modération Admin & Retrait après suppression de course', async () => {
      // 6.1 Runner Rankings (City, Governorate, Country)
      for (const scope of ['city', 'governorate', 'country']) {
        const rk = await jsonReq('GET', `/api/users/rankings?scope=${scope}`, tokenB);
        assert.equal(rk.status, 200);
        assert.ok(rk.data.rankings.length >= 2);
      }

      // 6.2 Internal Group Leaderboard (Section 7.A: distance, runs, regularity; week & month)
      const lbDistance = await jsonReq(
        'GET',
        `/api/groups/${group1Id}/leaderboard?metric=distance&period=month`,
        tokenB,
      );
      assert.equal(lbDistance.status, 200);
      assert.equal(lbDistance.data.leaderboard[0].userId, userBId, 'Sarra (2 courses, ~7.2 km) est #1');
      assert.equal(lbDistance.data.leaderboard[0].rank, 1);

      const lbRuns = await jsonReq(
        'GET',
        `/api/groups/${group1Id}/leaderboard?metric=runs&period=month`,
        tokenB,
      );
      assert.equal(lbRuns.status, 200);
      assert.equal(lbRuns.data.leaderboard[0].runsCount, 2);

      const lbRegularity = await jsonReq(
        'GET',
        `/api/groups/${group1Id}/leaderboard?metric=regularity&period=month`,
        tokenB,
      );
      assert.equal(lbRegularity.status, 200);
      assert.equal(
        lbRegularity.data.leaderboard[0].regularityDays,
        2,
        'Sarra a couru sur 2 jours distincts',
      );

      // 6.3 Inter-Group Rankings (Section 7.B: city, governorate, country; total vs average)
      const grpRankTotal = await jsonReq(
        'GET',
        '/api/groups/rankings?scope=city&period=month&metric=total',
        tokenA,
      );
      assert.equal(grpRankTotal.status, 200);
      assert.ok(grpRankTotal.data.rankings.some((g) => g.id === group1Id));

      const grpRankAvg = await jsonReq(
        'GET',
        '/api/groups/rankings?scope=country&period=month&metric=average',
        tokenA,
      );
      assert.equal(grpRankAvg.status, 200);
      assert.ok(grpRankAvg.data.rankings.some((g) => g.id === group1Id));

      // Verify Group Page displays its 3 geographic ranks (City, Governorate, Country)
      const g1Page = await jsonReq('GET', `/api/groups/${group1Id}?period=month`, tokenA);
      assert.equal(g1Page.status, 200);
      assert.ok(g1Page.data.group.ranks.city.rank >= 1);
      assert.ok(g1Page.data.group.ranks.governorate.rank >= 1);
      assert.ok(g1Page.data.group.ranks.country.rank >= 1);

      // 6.4 Admin Supervision & Report Moderation
      const adminGroups = await jsonReq('GET', `/api/admin/groups?search=${TEST_TAG}`, tokenAdmin);
      assert.equal(adminGroups.status, 200);
      assert.equal(adminGroups.data.groups.length, 3);
      assert.ok(adminGroups.data.pendingReportsCount >= 1);

      const adminGroupDetail = await jsonReq('GET', `/api/admin/groups/${group1Id}`, tokenAdmin);
      assert.equal(adminGroupDetail.status, 200);
      assert.equal(adminGroupDetail.data.reports.length, 1);

      const reportId = adminGroupDetail.data.reports[0]._id;
      const resolveReport = await jsonReq('PATCH', `/api/admin/reports/${reportId}`, tokenAdmin, {
        status: 'dismissed',
        deletePost: false,
      });
      assert.equal(resolveReport.status, 200);
      assert.equal(resolveReport.data.report.status, 'dismissed');

      // 6.5 Deleting / Invalidating a Run removes its kilometres from Group Totals & Leaderboards (Section 9)
      const g1BeforeDelete = await jsonReq('GET', `/api/groups/${group1Id}`, tokenB);
      const distanceBeforeDelete = g1BeforeDelete.data.group.totalDistanceMetres;

      const deleteRunRes = await jsonReq('DELETE', `/api/runs/${runB2Id}`, tokenB);
      assert.equal(deleteRunRes.status, 200);
      assert.equal(deleteRunRes.data.deleted, true);

      const g1AfterDelete = await jsonReq('GET', `/api/groups/${group1Id}`, tokenB);
      assert.ok(
        g1AfterDelete.data.group.totalDistanceMetres < distanceBeforeDelete,
        'Les kilomètres de la course supprimée ont été retirés du groupe',
      );
    });
  } finally {
    // Clean up all test entities so the database stays clean
    await Promise.all([
      User.deleteMany({ _id: { $in: createdUserIds } }),
      Run.deleteMany({ user: { $in: createdUserIds } }),
      RunComment.deleteMany({ user: { $in: createdUserIds } }),
      UserBadge.deleteMany({ user: { $in: createdUserIds } }),
      UserDefi.deleteMany({ user: { $in: createdUserIds } }),
      createdBadgeId ? Badge.deleteOne({ _id: createdBadgeId }) : Promise.resolve(),
      createdDefiId ? Defi.deleteOne({ _id: createdDefiId }) : Promise.resolve(),
      Group.deleteMany({ _id: { $in: createdGroupIds } }),
      GroupMember.deleteMany({ group: { $in: createdGroupIds } }),
      GroupRunContribution.deleteMany({ group: { $in: createdGroupIds } }),
      GroupPost.deleteMany({ group: { $in: createdGroupIds } }),
      GroupPostComment.deleteMany({ group: { $in: createdGroupIds } }),
      GroupChallenge.deleteMany({ group: { $in: createdGroupIds } }),
      GroupChallengeParticipant.deleteMany({ group: { $in: createdGroupIds } }),
      GroupReport.deleteMany({ group: { $in: createdGroupIds } }),
    ]);

    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
  }
});
