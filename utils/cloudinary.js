const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const FOLDER = process.env.CLOUDINARY_FOLDER || 'kaagazaad';

// How long a freshly-minted signed URL stays valid for. Short enough that
// a leaked link (browser history, a proxy log, a chat export) is only
// useful briefly; long enough that a normal "open this document" tap in
// the app doesn't race against expiry. Callers can pass a longer TTL for
// cases that genuinely need it (e.g. a document explicitly shared out).
const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Uploads a buffer as a PRIVATE ("authenticated" delivery type) Cloudinary
 * asset. Unlike the default "upload" delivery type — where anyone who has
 * or guesses the URL can fetch the file forever — an "authenticated" asset
 * cannot be fetched from its public_id alone; every delivery URL must
 * carry a valid, time-limited signature (see mintSignedUrl below). This is
 * what makes user documents (which may contain Aadhaar copies, insurance
 * policies, etc.) private rather than "unlisted but public."
 *
 * Returns the asset's identity (NOT a URL — see resolveDocumentUrl for why
 * a URL is minted at read time instead of stored).
 */
function uploadBufferToCloudinary(buffer, publicId, resourceType = 'auto') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: FOLDER,
        public_id: publicId,
        resource_type: resourceType,
        type: 'authenticated',
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          publicId: result.public_id,
          resourceType: result.resource_type,
          format: result.format,
        });
      }
    );
    stream.end(buffer);
  });
}

/**
 * Mints a fresh, time-limited signed URL for a private ("authenticated")
 * asset. Call this at READ time (e.g. right before returning an asset list
 * to a client) rather than storing the signed URL — a stored signed URL
 * will silently start failing once its expiry passes.
 */
function mintSignedUrl({ publicId, resourceType = 'raw', format }, ttlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS) {
  if (!publicId) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return cloudinary.url(publicId, {
    resource_type: resourceType,
    type: 'authenticated',
    sign_url: true,
    secure: true,
    format,
    expires_at: expiresAt,
  });
}

/**
 * Resolves one `Asset.documents[]` entry into a viewable URL for an API
 * response. Handles both shapes that can exist in the database:
 *  - a legacy plain string — a public "upload"-type URL saved before this
 *    hardening pass. Returned as-is; it's already directly accessible.
 *  - a new-style object `{ publicId, resourceType, format }` — a fresh
 *    short-lived signed URL is minted on every call.
 */
function resolveDocumentUrl(entry, ttlSeconds) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && entry.publicId) {
    return mintSignedUrl(entry, ttlSeconds);
  }
  return null;
}

function parseCloudinaryUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/([^/]+)\/(?:upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?(?:\?.*)?$/);
  if (!match) return null;
  const resourceType = url.includes('/image/')
    ? 'image'
    : url.includes('/video/')
      ? 'video'
      : 'raw';
  return { publicId: match[2], resourceType };
}

/**
 * Deletes an asset given either a legacy URL string or a new-style
 * `{ publicId, resourceType }` object. Tries the "authenticated" delivery
 * type first (what every new upload uses), then falls back to "upload"
 * for pre-hardening assets that were never migrated.
 */
async function deleteFromCloudinaryByUrl(entryOrUrl) {
  let publicId;
  let resourceType;
  if (typeof entryOrUrl === 'string') {
    if (!entryOrUrl || !entryOrUrl.includes('cloudinary.com')) return;
    const parsed = parseCloudinaryUrl(entryOrUrl);
    if (!parsed) return;
    publicId = parsed.publicId;
    resourceType = parsed.resourceType;
  } else if (entryOrUrl && entryOrUrl.publicId) {
    publicId = entryOrUrl.publicId;
    resourceType = entryOrUrl.resourceType || 'raw';
  } else {
    return;
  }
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: 'authenticated', invalidate: true });
  } catch (err) {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: 'upload', invalidate: true });
    } catch (err2) {
      console.error(`[Cloudinary] Failed to delete ${publicId}:`, err2.message);
    }
  }
}

/**
 * Matches a client-supplied `filename` (for backward compatibility, still
 * whatever URL string the client last saw for a document) against a
 * stored `documents[]` entry, by comparing the underlying Cloudinary
 * public_id rather than the full URL string. Necessary because signed
 * URLs for authenticated assets change every time they're minted — an
 * exact-string match would never find the right document to delete.
 */
function documentEntryMatches(entry, clientFilename) {
  if (typeof entry === 'string') return entry === clientFilename;
  if (!entry || !entry.publicId) return false;
  const parsed = parseCloudinaryUrl(clientFilename);
  return Boolean(parsed && parsed.publicId === entry.publicId);
}

module.exports = {
  cloudinary,
  uploadBufferToCloudinary,
  mintSignedUrl,
  resolveDocumentUrl,
  deleteFromCloudinaryByUrl,
  documentEntryMatches,
  parseCloudinaryUrl,
};
