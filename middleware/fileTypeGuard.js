const FileType = require('file-type');
const path = require('path');
const ALLOWED_TYPES = {
  'application/pdf': { extensions: ['pdf'], resourceType: 'raw' },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], resourceType: 'image' },
  'image/png': { extensions: ['png'], resourceType: 'image' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensions: ['docx'], resourceType: 'raw' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extensions: ['xlsx'], resourceType: 'raw' },
};
const CFB_MIME = 'application/x-cfb';
const CFB_EXTENSION_RESOURCE_TYPE = { doc: 'raw', xls: 'raw' };
function extOf(filename) {
  return path.extname(filename || '').replace('.', '').toLowerCase();
}
async function detectFile(buffer) {
  try {
    return await FileType.fromBuffer(buffer);
  } catch {
    return null; // buffer too short / corrupted to sniff
  }
}
/**
 * Validates one already-buffered upload (from multer memoryStorage)
 * against its REAL file signature — not the client-supplied mimetype or
 * the filename's extension alone. `allowedExts`, if given, further
 * restricts which extensions are acceptable for this particular endpoint
 * (e.g. an OCR endpoint that only ever wants images).
 */
async function verifyUploadedFile(file, allowedExts) {
  const claimedExt = extOf(file.originalname);
  const restrictSet = allowedExts ? new Set(allowedExts) : null;
  if (restrictSet && !restrictSet.has(claimedExt)) {
    return { ok: false, reason: `"${claimedExt || 'unknown'}" files are not accepted here.` };
  }
  const detected = await detectFile(file.buffer);
  if (!detected) {
    return { ok: false, reason: 'Could not verify the file contents — it may be corrupted or is not a supported type.' };
  }
  if (detected.mime === CFB_MIME) {
    if (Object.prototype.hasOwnProperty.call(CFB_EXTENSION_RESOURCE_TYPE, claimedExt)) {
      return { ok: true, resourceType: CFB_EXTENSION_RESOURCE_TYPE[claimedExt], ext: claimedExt };
    }
    return { ok: false, reason: 'This file looks like a legacy Office document but its extension does not match its contents.' };
  }
  const rule = ALLOWED_TYPES[detected.mime];
  if (!rule || !rule.extensions.includes(claimedExt)) {
    return { ok: false, reason: `The file's actual contents ("${detected.ext || detected.mime}") do not match its ".${claimedExt}" extension.` };
  }
  return { ok: true, resourceType: rule.resourceType, ext: claimedExt };
}
function fileTypeGuard({ allowedExts } = {}) {
  return async function (req, res, next) {
    try {
      const files = req.files || (req.file ? [req.file] : []);
      if (files.length === 0) return next();
      for (const file of files) {
        const result = await verifyUploadedFile(file, allowedExts);
        if (!result.ok) {
          return res.status(400).json({ error: result.reason });
        }
        file.verifiedResourceType = result.resourceType;
        file.verifiedExt = result.ext;
      }
      return next();
    } catch (err) {
      console.error('[fileTypeGuard] verification error:', err);
      return res.status(400).json({ error: 'Could not verify the uploaded file.' });
    }
  };
}
module.exports = { fileTypeGuard, verifyUploadedFile };
