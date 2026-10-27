const crypto = require('crypto');
const sharp = require('sharp');
const { getStorage, getDownloadURL } = require('firebase-admin/storage');
const firebaseApp = require('./firebase');

const createStorageError = (message, code, status) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const getStorageBucket = () => {
  if (!firebaseApp) {
    throw createStorageError(
      "Le stockage des images est temporairement indisponible.",
      'IMAGE_STORAGE_UNAVAILABLE',
      503,
    );
  }

  try {
    const bucket = getStorage(firebaseApp).bucket();
    if (!bucket.name) throw new Error('Aucun bucket Firebase Storage configuré.');
    return bucket;
  } catch (error) {
    throw createStorageError(
      "Le stockage des images est mal configuré.",
      'IMAGE_STORAGE_UNAVAILABLE',
      503,
    );
  }
};

const processImage = async (inputBuffer) => {
  try {
    const { data, info } = await sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({
        width: 512,
        height: 512,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      metadata: {
        contentType: 'image/png',
        sizeBytes: info.size,
        width: info.width,
        height: info.height,
      },
    };
  } catch (error) {
    throw createStorageError(
      "L'image est invalide ou ne peut pas être traitée.",
      'IMAGE_INVALID',
      422,
    );
  }
};

const uploadImage = async (buffer, folder = 'badges') => {
  const bucket = getStorageBucket();
  const processed = await processImage(buffer);
  const storagePath = `${folder}/${Date.now()}-${crypto.randomUUID()}.png`;
  const downloadToken = crypto.randomUUID();
  const file = bucket.file(storagePath);
  let uploaded = false;

  try {
    await file.save(processed.buffer, {
      resumable: false,
      metadata: {
        contentType: processed.metadata.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });
    uploaded = true;

    const url = await getDownloadURL(file);
    return {
      url,
      path: storagePath,
      metadata: processed.metadata,
    };
  } catch (error) {
    if (uploaded) {
      try {
        await file.delete({ ignoreNotFound: true });
      } catch (rollbackError) {
        console.error("Impossible de supprimer l'image après un upload incomplet:", rollbackError);
      }
    }

    if (error.status && error.code) throw error;
    throw createStorageError(
      "L'envoi de l'image a échoué. Veuillez réessayer.",
      'IMAGE_UPLOAD_FAILED',
      502,
    );
  }
};

const deleteImage = async (storagePath) => {
  if (!storagePath) return;
  const bucket = getStorageBucket();
  await bucket.file(storagePath).delete({ ignoreNotFound: true });
};

module.exports = {
  deleteImage,
  processImage,
  uploadImage,
};
