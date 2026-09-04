const mongoose = require("mongoose");
const SharedDocumentSchema = new mongoose.Schema({
  ownerCustomerId: {
    type: String,
    required: true,
    index: true
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
    default: null,
    index: true
  },
  receiverEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  receiverName: {
    type: String,
    default: ""
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
    default: "active",
    index: true
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
SharedDocumentSchema.index({
  ownerCustomerId: 1,
  receiverEmail: 1,
  assetId: 1
}, {
  unique: true,
  partialFilterExpression: {
    status: "active"
  }
});
module.exports = mongoose.model("SharedDocument", SharedDocumentSchema);