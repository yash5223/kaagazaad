const mongoose = require("mongoose");
const alertSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: [ "info", "warning", "success", "error", "reminder", "announcement" ],
    default: "info"
  },
  priority: {
    type: String,
    enum: [ "low", "medium", "high" ],
    default: "medium"
  },
  sent_by: {
    type: String,
    default: "System"
  },
  sent_to: {
    type: String,
    required: true
  },
  related_asset_id: {
    type: String,
    default: null
  },
  is_read: {
    type: Boolean,
    default: false
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  created_time: {
    type: String,
    default: () => (new Date).toLocaleTimeString()
  }
}, {
  versionKey: false
});
// created_at stays plaintext: it is record metadata used for ordering (like createdAt).
alertSchema.plugin(require("../utils/encryptedFields"), {
  collection: "alerts",
  plain: ["created_at"],
  lookups: {sent_to: {}, related_asset_id: {}}
});
module.exports = mongoose.model("Alert", alertSchema);
