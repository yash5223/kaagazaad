const mongoose = require('mongoose');
const otpSchema = new mongoose.Schema({
  contactInfo: { type: String, required: true, lowercase: true, trim: true },
  otpCode: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  purpose: {
    type: String,
    enum: ['password_reset', 'register', 'register_verified'],
    default: 'password_reset'
  },
  // Number of failed verification attempts against this specific code.
  // Once this hits OTP_MAX_ATTEMPTS (see routes/userRoutes.js), the code
  // is invalidated and the user has to request a fresh one — this stops
  // someone from brute-forcing a 6-digit OTP within its validity window.
  attempts: { type: Number, default: 0 }
});
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('Otp', otpSchema, 'password_resets');
