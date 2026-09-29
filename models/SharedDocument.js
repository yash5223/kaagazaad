const mongoose = require("mongoose");
const SharedDocumentSchema = new mongoose.Schema({
  ownerCustomerId: {
    type: String,
    required: true
  },
  ownerName: {
    type: String,
    default: ""
  },
  ownerEmail: {
    type: String,
    default: ""
  },
  receiverCustomerId: {
    type: String,
    default: null
  },
  receiverEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  receiverName: {
    type: String,
    default: ""
  },
  receiverPhone: {
    type: String,
    default: ""
  },
  recipientLabel: {
    type: String,
    default: ""
  },
  expiresAt: {
    type: Date,
    default: null
  },
  viewOnly: {
    type: Boolean,
    default: true
  },
  pinHash: {
    type: String,
    default: "",
    select: false
  },
  requiresPin: {
    type: Boolean,
    default: false
  },
  watermarkText: {
    type: String,
    default: ""
  },
  firstViewedAt: {
    type: Date,
    default: null
  },
  lastViewedAt: {
    type: Date,
    default: null
  },
  viewCount: {
    type: Number,
    default: 0
  },
  assetId: {
    type: String,
    required: true
  },
  documentPath: {
    type: String,
    default: ""
  },
  documentName: {
    type: String,
    default: ""
  },
  category: {
    type: String,
    default: ""
  },
  subCategory: {
    type: String,
    default: ""
  },
  subSubCategory: {
    type: String,
    default: ""
  },
  status: {
    type: String,
    enum: [ "active", "revoked" ],
    default: "active"
  },
  sharedAt: {
    type: Date,
    default: Date.now
  },
  revokedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});
// pinHash is a bcrypt hash (already one-way) and must keep `select: false`.
SharedDocumentSchema.plugin(require("../utils/encryptedFields"), {
  collection: "shareddocuments",
  plain: ["pinHash"],
  lookups: {ownerCustomerId: {}, receiverCustomerId: {}, receiverEmail: {}, assetId: {}},
  // replaces the old partial-unique index on {owner, receiverEmail, assetId} where status = active
  composites: [{
    name: "activeShareIdx",
    fields: ["ownerCustomerId", "receiverEmail", "assetId"],
    unique: true,
    when: doc => doc.status === "active"
  }]
});
module.exports = mongoose.model("SharedDocument", SharedDocumentSchema);
