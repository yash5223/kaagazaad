const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  // Father's name is optional — some ID flows don't need it, and requiring
  // it here would block otherwise-valid registrations.
  fatherName: { type: String, default: '', trim: true },
  dob: { type: Date, required: true },
  gender: { type: String, required: true, enum: ['Male', 'Female', 'Other'] },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  // The Aadhaar number itself is never stored in plaintext. `aadhaarEncrypted`
  // holds an AES-256-GCM ciphertext (see utils/aadhaarCrypto.js) that's only
  // ever decrypted for display to the verified account owner. `aadhaarHash`
  // is a deterministic HMAC of the raw number, used for the uniqueness
  // constraint and lookups, since the encrypted value itself isn't
  // queryable (a fresh random IV means the same Aadhaar number encrypts to
  // a different string every time).
  aadhaarEncrypted: { type: String, required: true },
  aadhaarHash: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true }, 
  emailVerified: { type: Boolean, default: false },
  subscription_plan: { type: String, default: ""  },
  customer_id: { type: String, unique: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  pinHash: { type: String, default: null },
  pinEnabled: { type: Boolean, default: false },
  // --- Brute-force lockout state (see utils/accountLockout.js) ---
  // Kept separate for login vs PIN since they're different attack surfaces
  // (password login is also behind the IP-based authLimiter; the PIN is a
  // much smaller keyspace and only reachable by someone who already holds
  // a valid session token, so it gets its own counter/lock).
  failedLoginAttempts: { type: Number, default: 0 },
  loginLockedUntil: { type: Date, default: null },
  loginLockoutCount: { type: Number, default: 0 },
  failedPinAttempts: { type: Number, default: 0 },
  pinLockedUntil: { type: Date, default: null },
  pinLockoutCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
// Kept for backward compatibility with every part of the app (API
// responses, JWT payloads read by the frontend, etc.) that reads
// `user.fullName`. Accessing this on a Mongoose document computes it live
// from firstName/lastName — no schema migration needed on the read side.
userSchema.virtual('fullName').get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ');
});
// Safety net: if any route ever does `res.json(user)` or `res.json({ user })`
// with a raw document instead of hand-picking fields (as the routes in
// userRoutes.js currently do), this stops password hashes, PIN hashes, and
// the encrypted/hashed Aadhaar fields from ever being serialized out.
const stripSensitiveFields = (doc, ret) => {
  delete ret.passwordHash;
  delete ret.pinHash;
  delete ret.aadhaarEncrypted;
  delete ret.aadhaarHash;
  delete ret.__v;
  return ret;
};
userSchema.set('toJSON', { virtuals: true, transform: stripSensitiveFields });
userSchema.set('toObject', { virtuals: true, transform: stripSensitiveFields });
module.exports = mongoose.model('User', userSchema, 'users');
