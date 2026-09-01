const mongoose = require('mongoose');
const serviceRecordSchema = new mongoose.Schema(
  {
    title: { type: String, default: '' },
    date: { type: Date },
    cost: { type: Number, default: 0 },
    notes: { type: String, default: '-' },
  }
  // Each service record now gets its own auto-generated `_id` (Mongoose's
);
const assetSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    subCategory: { type: String, required: true },
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
    // Mixed, not String: documents saved before this security hardening
    // pass are plain public Cloudinary URL strings. Documents saved after
    // it are private "authenticated" Cloudinary assets, stored as
    // { publicId, resourceType, format } so a fresh signed, time-limited
    // URL can be minted on every read (see utils/cloudinary.js) instead of
    // a permanent public link being stored or handed out. Mixed keeps both
    // shapes valid so existing production data doesn't need a migration.
    documents: { type: [mongoose.Schema.Types.Mixed], default: [] },
    serviceRecords: { type: [serviceRecordSchema], default: [] },
  },
  {
    timestamps: true,
    // The Flutter upload form asks a different set of questions per
    // document type (e.g. Aadhaar Card -> fullName/aadhaarNumber/gender/...,
    // Passport -> passportNumber/nationality/..., see
    // upload_screen.dart's `_documentFieldLabels`). There are ~150 such
    // keys across all document types, so instead of declaring every one of
    // them as a schema path, `strict: false` lets Mongoose persist whatever
    // extra flat fields routes/assetRoutes.js passes through for a given
    // document type, alongside the fixed fields above.
    strict: false,
  }
);
module.exports = mongoose.model('Asset', assetSchema);