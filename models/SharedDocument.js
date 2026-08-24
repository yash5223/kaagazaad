const mongoose = require('mongoose');

const SharedDocumentSchema = new mongoose.Schema(
  {
    ownerCustomerId: { type: String, required: true, index: true },
    ownerName: { type: String, default: '' },
    ownerEmail: { type: String, default: '' },

    receiverCustomerId: { type: String, default: null, index: true },
    receiverEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    receiverName: { type: String, default: '' },

    // A share now refers to the whole asset (which can contain several
    // document files), not a single file path. documentPath is kept for
    // backward compatibility / display (e.g. thumbnail) but is optional.
    assetId: { type: String, required: true },
    documentPath: { type: String, default: '' },
    documentName: { type: String, default: '' },

    category: { type: String, default: '' },
    subCategory: { type: String, default: '' },
    subSubCategory: { type: String, default: '' },

    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    sharedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Only one ACTIVE share of a given asset to a given receiver is allowed at a
// time (a partial unique index — it ignores revoked rows), so re-sharing
// while already active won't create a duplicate. Once revoked, that row is
// just history: sharing the same asset again creates a brand new row, so
// every share/revoke cycle is preserved for both sender and receiver.
SharedDocumentSchema.index(
  { ownerCustomerId: 1, receiverEmail: 1, assetId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

module.exports = mongoose.model('SharedDocument', SharedDocumentSchema);