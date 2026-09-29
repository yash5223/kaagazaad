const mongoose = require("mongoose");
const securityEventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true
  },
  userId: {
    type: String,
    default: null
  },
  email: {
    type: String,
    default: null
  },
  ip: {
    type: String,
    default: null
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});
securityEventSchema.index({
  createdAt: 1
}, {
  expireAfterSeconds: 60 * 60 * 24 * 90
});
// createdAt stays plaintext: the 90-day TTL index needs a real date.
securityEventSchema.plugin(require("../utils/encryptedFields"), {
  collection: "securityevents",
  lookups: {userId: {}}
});
module.exports = mongoose.model("SecurityEvent", securityEventSchema);
