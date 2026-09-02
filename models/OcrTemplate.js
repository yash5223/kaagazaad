const mongoose = require('mongoose');
const OcrTemplateSchema = new mongoose.Schema({
  documentType: { type: String, required: true, index: true },
  fingerprint: { type: String, required: true },
  anchors: [{ key: String, x: Number, y: Number }],
  fields: { type: mongoose.Schema.Types.Mixed, default: {} }, 
  sampleCount: { type: Number, default: 1 },
}, { timestamps: true });
OcrTemplateSchema.index({ documentType: 1, fingerprint: 1 }, { unique: true });
module.exports = mongoose.model('OcrTemplate', OcrTemplateSchema);
