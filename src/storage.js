const { getStorage, getDownloadURL } = require('firebase-admin/storage');
const firebaseApp = require('./firebase');

/**
 * Uploads a base64 encoded image to Firebase Storage and returns the public download URL.
 * Falls back to returning the base64 string directly if Firebase is not configured.
 * 
 * @param {string} base64Str The base64 data URI (e.g. data:image/png;base64,...)
 * @param {string} userId The unique ID of the user for naming the file
 * @returns {Promise<string>} The public download URL or original string if fallback
 */
const uploadBase64ToFirebase = async (base64Str, userId) => {
  if (!firebaseApp) {
    console.warn('Firebase App not initialized. Storing base64 string directly in MongoDB.');
    return base64Str;
  }

  try {
    // Validate if it is a base64 data URI
    const match = base64Str.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) {
      // If it is not a base64 string (e.g., preset URL), return it directly
      return base64Str;
    }

    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, 'base64');
    
    const bucket = getStorage(firebaseApp).bucket();
    if (!bucket.name) {
      throw new Error('Firebase Storage bucket is not configured.');
    }

    const filename = `avatars/${userId}_${Date.now()}.jpg`;
    const file = bucket.file(filename);

    // Save the image buffer directly to the storage bucket
    await file.save(buffer, {
      metadata: { 
        contentType: mimeType,
        cacheControl: 'public, max-age=31536000'
      },
      public: true // Set file permissions to public read
    });

    // Retrieve the permanent public download URL
    const downloadUrl = await getDownloadURL(file);
    return downloadUrl;
  } catch (error) {
    console.error('Firebase Storage upload failed:', error.message);
    // Return original string as fallback to guarantee database write succeeds
    return base64Str;
  }
};

module.exports = { uploadBase64ToFirebase };
