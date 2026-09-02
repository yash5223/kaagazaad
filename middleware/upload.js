const multer = require('multer');
const path = require('path');
const ALLOWED_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'xls', 'xlsx']);
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
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
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: extensionFileFilter,
});
module.exports = { documentUpload, ALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES };
