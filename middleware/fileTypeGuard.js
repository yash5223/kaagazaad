const FileType = require('file-type');
const path = require('path');

// Canonical allow-list: maps a magic-byte-DETECTED mime type to the
// extensions it's allowed to claim, plus the Cloudinary resource_type it
// should be stored as. The client-supplied `file.mimetype` (an HTTP
// header the client sets) is never trusted — only what's actually sniffed
// from the file's bytes here.
const ALLOWED_TYPES = {
  'application/pdf': { extensions: ['pdf'], resourceType: 'raw' },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], resourceType: 'image' },
  'image/png': { extensions: ['png'], resourceType: 'image' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensions: ['docx'], resourceType: 'raw' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extensions: ['xlsx'], resourceType: 'raw' },
};

// Legacy MS Office binary formats (.doc, .xls) all share the exact same
// OLE2/Compound File Binary container signature (D0 CF 11 E0 A1 B1 1A E1)
// — there is no magic-byte way to tell a .doc apart from a .xls (or a
// .ppt) from the header alone. `file-type` correctly reports all of them
// as the same generic container type. For these two we require BOTH the
// generic CFB signature (rules out "renamed .exe to invoice.doc") AND a
// matching extension — the closest a signature-only check can get without
// a full OLE stream parser.
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

/**
 * Express middleware factory. Place AFTER a multer memoryStorage upload
 * (`upload.single(field)` / `upload.array(field, n)`) so `req.file` /
 * `req.files` are already fully buffered. Rejects any file whose sniffed
 * content doesn't match an allowed type — this is what stops someone from
 * renaming `payload.exe` to `invoice.pdf` and sailing through a
 * MIME-header-only check.
 *
 * On success, each verified file gets `file.verifiedResourceType` and
 * `file.verifiedExt` set, for routes to use instead of re-deriving them.
 */
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
