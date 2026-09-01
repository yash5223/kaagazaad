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
    // Deliberately NOT declaring documentNumber/issuingAuthority/expiryDate/
    // valueAmount/invoiceNumber (or any other dynamic field) as schema
    // paths here. A `default: ''` on a declared path gets applied by
    // Mongoose on every new document regardless of what was actually sent,
    // which is exactly the "extra fields the UI never asked for" problem.
    // Instead, `strict: false` below lets routes/assetRoutes.js write
    // exactly the flat dynamic fields the upload form sent for that
    // specific document type (fullName/aadhaarNumber/... for an Aadhaar
    // Card, documentNumber/issuingAuthority/expiryDate/amount for a
    // generic/unlisted type, etc.) — no more, no less — and nothing else
    // gets auto-added.
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