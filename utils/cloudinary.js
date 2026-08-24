const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const FOLDER = process.env.CLOUDINARY_FOLDER || 'kaagazaad';
function uploadBufferToCloudinary(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: FOLDER,
        public_id: publicId,
        resource_type: 'auto', 
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}
function parseCloudinaryUrl(url) {
  const match = url.match(/\/([^/]+)\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
  if (!match) return null;
  const resourceType = url.includes('/image/upload/')
    ? 'image'
    : url.includes('/video/upload/')
      ? 'video'
      : 'raw';
  return { publicId: match[2], resourceType };
}
async function deleteFromCloudinaryByUrl(url) {
  if (!url || typeof url !== 'string' || !url.includes('res.cloudinary.com')) {
    return; 
  }
  const parsed = parseCloudinaryUrl(url);
  if (!parsed) return;
  try {
    await cloudinary.uploader.destroy(parsed.publicId, { resource_type: parsed.resourceType });
  } catch (err) {
    console.error(`[Cloudinary] Failed to delete ${parsed.publicId}:`, err.message);
  }
}
module.exports = {
  cloudinary,
  uploadBufferToCloudinary,
  deleteFromCloudinaryByUrl,
};
