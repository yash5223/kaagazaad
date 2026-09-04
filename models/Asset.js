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
    required: true
  },
  category: {
    type: String,
    required: true
  },
  subCategory: {
    type: String,
    required: true
  },
  subSubCategory: {
    type: String,
    required: true
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
module.exports = mongoose.model("Asset", assetSchema);