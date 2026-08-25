const mongoose = require('mongoose');

// A lightweight audit trail of security-relevant events (auth, PIN,
// lockouts, document deletion) — separate from the app's normal
// console logging so it can be queried/reported on without grepping
// server logs. Kept intentionally flat and small; this is an audit trail,
// not an analytics store.
const securityEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true }, // e.g. 'login_failure', 'pin_lockout'
    userId: { type: String, default: null, index: true }, // customer_id when known
    email: { type: String, default: null },
    ip: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Auto-expire after 90 days via a TTL index — long enough for incident
// review, short enough that this collection doesn't grow unbounded.
securityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('SecurityEvent', securityEventSchema);
