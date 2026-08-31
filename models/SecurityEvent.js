const mongoose = require('mongoose');
const securityEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    userId: { type: String, default: null, index: true },
    email: { type: String, default: null },
    ip: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
securityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
module.exports = mongoose.model('SecurityEvent', securityEventSchema);
