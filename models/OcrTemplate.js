const mongoose = require('mongoose');

// One document per learned layout. documentType + fingerprint together
// identify a distinct layout (e.g. "old paper Aadhaar" vs "new PVC Aadhaar"
// naturally end up as separate documents here, since their anchor positions
// differ enough to produce different fingerprints) — see utils/ocrTemplates.js
// for how fingerprint/matching/learning actually works.
const OcrTemplateSchema = new mongoose.Schema({
  documentType: { type: String, required: true, index: true },
  fingerprint: { type: String, required: true },
  anchors: [{ key: String, x: Number, y: Number }],
  fields: { type: mongoose.Schema.Types.Mixed, default: {} }, // { [fieldKey]: { anchorKey, dx, dy, width, height } }
  sampleCount: { type: Number, default: 1 },
}, { timestamps: true });

OcrTemplateSchema.index({ documentType: 1, fingerprint: 1 }, { unique: true });

module.exports = mongoose.model('OcrTemplate', OcrTemplateSchema);