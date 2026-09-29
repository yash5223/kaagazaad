const mongoose = require("mongoose");
const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
    trim: true
  },
  lastName: {
    type: String,
    required: true,
    trim: true
  },
  fatherName: {
    type: String,
    default: "",
    trim: true
  },
  dob: {
    type: Date,
    required: true
  },
  gender: {
    type: String,
    required: true,
    enum: [ "Male", "Female", "Other" ]
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  aadhaarEncrypted: {
    type: String,
    required: true
  },
  aadhaarHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  subscription_plan: {
    type: String,
    default: ""
  },
  plan_expires_at: {
    type: Date,
    default: null
  },
  ai_usage: {
    type: Object,
    default: () => ({month: "", count: 0})
  },
  customer_id: {
    type: String
  },
  role: {
    type: String,
    enum: [ "user", "admin" ],
    default: "user"
  },
  // E2EE key bundle (all values are ciphertext; the server cannot unwrap them):
  // {v, kdfIter, wrappedMk (master key wrapped by password KEK), recoveryWrappedMk (wrapped by recovery key)}
  e2ee: {
    type: Object,
    default: null
  },
  pinHash: {
    type: String,
    default: null
  },
  pinEnabled: {
    type: Boolean,
    default: false
  },
  failedLoginAttempts: {
    type: Number,
    default: 0
  },
  loginLockedUntil: {
    type: Date,
    default: null
  },
  loginLockoutCount: {
    type: Number,
    default: 0
  },
  failedPinAttempts: {
    type: Number,
    default: 0
  },
  pinLockedUntil: {
    type: Date,
    default: null
  },
  pinLockoutCount: {
    type: Number,
    default: 0
  },
  tokenVersion: {
    type: Number,
    default: 0
  },
  trustedDevices: {
    type: [ {
      tokenHash: String,
      label: String,
      ip: String,
      addedAt: Date,
      lastSeenAt: Date,
      _id: false
    } ],
    default: []
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});
userSchema.virtual("fullName").get(function() {
  return [ this.firstName, this.lastName ].filter(Boolean).join(" ");
});
const stripSensitiveFields = (doc, ret) => {
  delete ret.passwordHash;
  delete ret.pinHash;
  delete ret.aadhaarEncrypted;
  delete ret.aadhaarHash;
  delete ret.trustedDevices;
  delete ret.__v;
  return ret;
};
userSchema.set("toJSON", {
  virtuals: true,
  transform: stripSensitiveFields
});
userSchema.set("toObject", {
  virtuals: true,
  transform: stripSensitiveFields
});
// Plaintext by necessity: hashes (one-way), aadhaarEncrypted (already AES-GCM), and
// tokenVersion + ai_usage (bumped with atomic $inc for session revocation / paid quota).
userSchema.plugin(require("../utils/encryptedFields"), {
  collection: "users",
  plain: ["passwordHash", "pinHash", "aadhaarHash", "aadhaarEncrypted", "tokenVersion", "ai_usage", "createdAt"],
  lookups: {email: {unique: true}, phone: {unique: true}, customer_id: {unique: true}}
});
module.exports = mongoose.model("User", userSchema, "users");
