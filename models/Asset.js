const mongoose = require('mongoose');

const serviceRecordSchema = new mongoose.Schema(
  {
    title: { type: String, default: '' },
    date: { type: Date },
    cost: { type: Number, default: 0 },
    notes: { type: String, default: '-' },
  }
  // Each service record now gets its own auto-generated `_id` (Mongoose's
  // default behavior) so a single record can be targeted for edit/delete
  // via /edit-service-record and /delete-service-record.
);

const assetSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },

    // Always present, regardless of document type
    name: { type: String, required: true },
    category: { type: String, required: true },
    subCategory: { type: String, required: true },
    // subSubCategory doubles as "document type" — the UI labels this field
    // "Document Type", but since the two were always the same value, we
    // store it once here instead of duplicating it into a separate
    // `documentType` field.
    subSubCategory: { type: String, required: true },
    issueDate: { type: Date },
    notesOrAddress: { type: String, default: '' },
    storeOrSeller: { type: String, default: '' },

    // Dynamic fields — only the ones relevant to `subSubCategory` (the
    // document type) get a real value when an asset is saved (see
    // config/documentFieldTemplates.js).
    // Every other key below is explicitly stored as '' so every document
    // in the collection has the same flat, predictable shape.
    documentNumber: { type: String, default: '' },
    issuingAuthority: { type: String, default: '' },
    expiryDate: { type: String, default: '' },
    valueAmount: { type: String, default: '' },
    invoiceNumber: { type: String, default: '' },

    documents: { type: [String], default: [] },
    serviceRecords: { type: [serviceRecordSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Asset', assetSchema);