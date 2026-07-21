const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

let firebasePublicKeys = {};
let lastFetchTime = 0;

const fetchFirebaseKeys = async () => {
  const now = Date.now();
  // Cache keys for 1 hour
  if (Object.keys(firebasePublicKeys).length > 0 && now - lastFetchTime < 3600000) {
    return firebasePublicKeys;
  }
  
  try {
    const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    firebasePublicKeys = await res.json();
    lastFetchTime = now;
    return firebasePublicKeys;
  } catch (err) {
    console.error('Failed to fetch Firebase public certificates:', err.message);
    return {};
  }
};

const verifyFirebaseToken = async (idToken) => {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      throw new Error('FIREBASE_PROJECT_ID is not defined in .env');
    }

    const decodedHeader = jwt.decode(idToken, { complete: true });
    if (!decodedHeader || !decodedHeader.header || !decodedHeader.header.kid) {
      throw new Error('Format de jeton invalide ou identifiant de clé (kid) manquant.');
    }

    const kid = decodedHeader.header.kid;
    const keys = await fetchFirebaseKeys();
    const cert = keys[kid];

    if (!cert) {
      throw new Error('Certificat public Firebase correspondant introuvable.');
    }

    // Verify token using jsonwebtoken against the Firebase certificate
    const decoded = jwt.verify(idToken, cert, {
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      algorithms: ['RS256']
    });

    return decoded;
  } catch (error) {
    console.error('Firebase token custom verification failed:', error.message);
    throw error;
  }
};

module.exports = { verifyFirebaseToken };
