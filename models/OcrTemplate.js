const mongoose = require("mongoose");
const OcrTemplateSchema = new mongoose.Schema({
  documentType: {
    type: String,
    required: true
  },
  fingerprint: {
    type: String,
    required: true
  },
  anchors: [ {
    key: String,
    x: Number,
    y: Number
  } ],
  fields: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  sampleCount: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});
OcrTemplateSchema.plugin(require("../utils/encryptedFields"), {
  collection: "ocrtemplates",
  lookups: {documentType: {}, fingerprint: {}},
  composites: [{name: "templateIdx", fields: ["documentType", "fingerprint"], unique: true}]
});
module.exports = mongoose.model("OcrTemplate", OcrTemplateSchema);
