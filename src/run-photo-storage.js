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

const getRunBucket = () => {
  if (!firebaseApp) {
    throw createStorageError(
      'Le stockage des photos est temporairement indisponible.',
      'PHOTO_STORAGE_UNAVAILABLE',
      503,
    );
  }

  try {
    const bucket = getStorage(firebaseApp).bucket();
    if (!bucket.name) throw new Error('Aucun bucket Firebase Storage configuré.');
    return bucket;
  } catch (error) {
    throw createStorageError(
      'Le stockage des photos est mal configuré.',
      'PHOTO_STORAGE_UNAVAILABLE',
      503,
    );
  }
};

const processRunPhoto = async (inputBuffer) => {
  try {
    const { data, info } = await sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({
        width: 2048,
        height: 2048,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      metadata: {
        contentType: 'image/jpeg',
        sizeBytes: info.size,
        width: info.width,
        height: info.height,
      },
    };
  } catch (error) {
    throw createStorageError(
      'La photo est invalide ou ne peut pas être traitée.',
      'PHOTO_INVALID',
      422,
    );
  }
};

const uploadRunPhoto = async ({ buffer, userId }) => {
  const bucket = getRunBucket();
  const processed = await processRunPhoto(buffer);
  const storagePath = `runs/${userId}/${Date.now()}-${crypto.randomUUID()}.jpg`;
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
        console.error('Impossible de supprimer la photo après un upload incomplet:', rollbackError);
      }
    }

    if (error.status && error.code) throw error;
    throw createStorageError(
      "L'envoi de la photo a échoué. Veuillez réessayer.",
      'PHOTO_UPLOAD_FAILED',
      502,
    );
  }
};

const deleteRunPhoto = async (storagePath) => {
  if (!storagePath) return;
  const bucket = getRunBucket();
  await bucket.file(storagePath).delete({ ignoreNotFound: true });
};

module.exports = {
  deleteRunPhoto,
  processRunPhoto,
  uploadRunPhoto,
};
