const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  fatherName: { type: String, default: '', trim: true },
  dob: { type: Date, required: true },
  gender: { type: String, required: true, enum: ['Male', 'Female', 'Other'] },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  aadhaarEncrypted: { type: String, required: true },
  aadhaarHash: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true }, 
  emailVerified: { type: Boolean, default: false },
  subscription_plan: { type: String, default: ""  },
  customer_id: { type: String, unique: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  pinHash: { type: String, default: null },
  pinEnabled: { type: Boolean, default: false },
  failedLoginAttempts: { type: Number, default: 0 },
  loginLockedUntil: { type: Date, default: null },
  loginLockoutCount: { type: Number, default: 0 },
  failedPinAttempts: { type: Number, default: 0 },
  pinLockedUntil: { type: Date, default: null },
  pinLockoutCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
userSchema.virtual('fullName').get(function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ');
});
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
