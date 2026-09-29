const mongoose = require("mongoose");
const refreshTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  family: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  familyExpiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Plaintext by necessity: token hash / family id / timestamps are opaque, and rotation is
// an atomic conditional findOneAndUpdate + TTL index. The user link is encrypted.
refreshTokenSchema.plugin(require("../utils/encryptedFields"), {
  collection: "refresh_tokens",
  plain: ["family", "tokenHash", "expiresAt", "familyExpiresAt", "usedAt", "createdAt"],
  lookups: {userId: {}}
});
module.exports = mongoose.model("RefreshToken", refreshTokenSchema, "refresh_tokens");
