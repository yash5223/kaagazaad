const mongoose = require("mongoose");
const otpSchema = new mongoose.Schema({
  contactInfo: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  otpCode: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  purpose: {
    type: String,
    enum: [ "password_reset", "register", "register_verified", "device_login" ],
    default: "password_reset"
  },
  attempts: {
    type: Number,
    default: 0
  }
});
otpSchema.index({
  expiresAt: 1
}, {
  expireAfterSeconds: 0
});
// Plaintext by necessity: otpCode (HMAC, one-way), expiresAt (TTL index), purpose and
// attempts (MongoDB evaluates them atomically to enforce the attempt limit).
otpSchema.plugin(require("../utils/encryptedFields"), {
  collection: "password_resets",
  plain: ["otpCode", "expiresAt", "purpose", "attempts"],
  lookups: {contactInfo: {}}
});
module.exports = mongoose.model("Otp", otpSchema, "password_resets");
