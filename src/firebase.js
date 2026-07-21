const { initializeApp, cert, getApps } = require('firebase-admin');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

let firebaseApp = null;

try {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
    
    const apps = getApps();
    if (apps.length === 0) {
      firebaseApp = initializeApp({
        credential: cert({
          projectId: projectId,
          clientEmail: clientEmail,
          privateKey: privateKey,
        }),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET
      });
      console.log('Firebase Admin initialized successfully.');
    } else {
      firebaseApp = apps[0];
    }
  } else {
    console.warn('Firebase configuration missing in .env. Firebase login/storage will be mocked.');
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin SDK:', error.message);
}

module.exports = firebaseApp;
