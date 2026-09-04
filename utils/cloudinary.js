const cloudinary = require("cloudinary").v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const FOLDER = process.env.CLOUDINARY_FOLDER || "kaagazaad";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;
function uploadBufferToCloudinary(buffer, publicId, resourceType = "auto") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: FOLDER,
      public_id: publicId,
      resource_type: resourceType,
      type: "authenticated",
      overwrite: true
    }, (error, result) => {
      if (error) return reject(error);
      resolve({
        publicId: result.public_id,
        resourceType: result.resource_type,
        format: result.format
      });
    });
    stream.end(buffer);
  });
}
function mintSignedUrl({publicId: publicId, resourceType: resourceType = "raw", format: format}, ttlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS) {
  if (!publicId) return null;
  const expiresAt = Math.floor(Date.now() / 1e3) + ttlSeconds;
  return cloudinary.url(publicId, {
    resource_type: resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
    format: format,
    expires_at: expiresAt
  });
}
function resolveDocumentUrl(entry, ttlSeconds) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && entry.publicId) {
    return mintSignedUrl(entry, ttlSeconds);
  }
  return null;
}
function parseCloudinaryUrl(url) {
  if (typeof url !== "string") return null;
  const match = url.match(/\/([^/]+)\/(?:upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?(?:\?.*)?$/);
  if (!match) return null;
  const resourceType = url.includes("/image/") ? "image" : url.includes("/video/") ? "video" : "raw";
  return {
    publicId: match[2],
    resourceType: resourceType
  };
}
async function deleteFromCloudinaryByUrl(entryOrUrl) {
  let publicId;
  let resourceType;
  if (typeof entryOrUrl === "string") {
    if (!entryOrUrl || !entryOrUrl.includes("cloudinary.com")) return;
    const parsed = parseCloudinaryUrl(entryOrUrl);
    if (!parsed) return;
    publicId = parsed.publicId;
    resourceType = parsed.resourceType;
  } else if (entryOrUrl && entryOrUrl.publicId) {
    publicId = entryOrUrl.publicId;
    resourceType = entryOrUrl.resourceType || "raw";
  } else {
    return;
  }
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type: "authenticated",
      invalidate: true
    });
  } catch (err) {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        type: "upload",
        invalidate: true
      });
    } catch (err2) {
      console.error(`[Cloudinary] Failed to delete ${publicId}:`, err2.message);
    }
  }
}
function documentEntryMatches(entry, clientFilename) {
  if (typeof entry === "string") return entry === clientFilename;
  if (!entry || !entry.publicId) return false;
  const parsed = parseCloudinaryUrl(clientFilename);
  return Boolean(parsed && parsed.publicId === entry.publicId);
}
module.exports = {
  cloudinary: cloudinary,
  uploadBufferToCloudinary: uploadBufferToCloudinary,
  mintSignedUrl: mintSignedUrl,
  resolveDocumentUrl: resolveDocumentUrl,
  deleteFromCloudinaryByUrl: deleteFromCloudinaryByUrl,
  documentEntryMatches: documentEntryMatches,
  parseCloudinaryUrl: parseCloudinaryUrl
};