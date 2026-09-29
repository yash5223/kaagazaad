const mongoose = require("mongoose");
const serviceRecordSchema = new mongoose.Schema({
  title: {
    type: String,
    default: ""
  },
  date: {
    type: Date
  },
  cost: {
    type: Number,
    default: 0
  },
  notes: {
    type: String,
    default: "-"
  }
});
const assetSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: function() { return !this.e2ee; }
  },
  category: {
    type: String,
    required: function() { return !this.e2ee; }
  },
  subCategory: {
    type: String,
    required: function() { return !this.e2ee; }
  },
  subSubCategory: {
    type: String,
    required: function() { return !this.e2ee; }
  },
  issueDate: {
    type: Date
  },
  notesOrAddress: {
    type: String
  },
  storeOrSeller: {
    type: String
  },
  // End-to-end encrypted record: `blob` is AES-256-GCM ciphertext produced on the device
  // (all fields + service records), `wrappedDek` is that record's key wrapped by the user's
  // master key. The server stores and returns them but can never read them.
  e2ee: { type: Boolean, default: false },
  blob: { type: String },
  wrappedDek: { type: String },
  documents: {
    type: [ mongoose.Schema.Types.Mixed ],
    default: []
  },
  serviceRecords: {
    type: [ serviceRecordSchema ],
    default: []
  }
}, {
  timestamps: true,
  strict: false
});
// EVERY field (name, category, dates, document list, service records and all dynamic
// OCR/form fields) is encrypted. `userId` and `documentNumber` get blind indexes so
// they can still be looked up.
const {blindIndex: legacyBlindIndex} = require("../utils/fieldCrypto");
assetSchema.plugin(require("../utils/encryptedFields"), {
  collection: "assets",
  lookups: {
    userId: {},
    documentNumber: {idx: "documentNumberIdx", legacyHash: legacyBlindIndex}
  }
});
module.exports = mongoose.model("Asset", assetSchema);
