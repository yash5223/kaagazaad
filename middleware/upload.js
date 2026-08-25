const multer = require('multer');
const path = require('path');

// Everything except PDF, JPG/JPEG, PNG, DOC, DOCX, XLS, XLSX is rejected.
// This is the SAME allow-list used by middleware/fileTypeGuard.js — this
// file does the cheap, early "is the extension even in the allowed set"
// check at the multer layer (before we spend time buffering the file);
// fileTypeGuard does the authoritative check afterward by sniffing the
// actual file bytes, since a client-supplied extension/mimetype is just a
// label the client chose and can't be trusted on its own.
const ALLOWED_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'xls', 'xlsx']);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB, matches prior limits

function extOf(filename) {
  return path.extname(filename || '').replace('.', '').toLowerCase();
}

function extensionFileFilter(req, file, cb) {
  const ext = extOf(file.originalname);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `"${ext || 'unknown'}" files are not accepted. Allowed types: PDF, JPG, PNG, DOC, DOCX, XLS, XLSX.`));
  }
  return cb(null, true);
}

/**
 * Shared multer instance for document/image uploads. Always uses
 * memoryStorage (never writes the raw upload to disk under a
 * client-controlled name) and always applies the extension allow-list.
 * Pair with middleware/fileTypeGuard.js on the route to also verify the
 * file's actual contents match what its name/extension claims.
 */
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: extensionFileFilter,
});

module.exports = { documentUpload, ALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES };
