const mongoose = require('mongoose');
const VaultMemberSchema = new mongoose.Schema({
  ownerCustomerId: { type: String, required: true },
  memberCustomerId: { type: String, required: true },
  memberEmail: { type: String, required: true, lowercase: true, trim: true },
  memberName: { type: String, default: '' },
  role: { type: String, enum: ['view', 'edit', 'admin'], default: 'view' },
  joinedAt: { type: Date, default: Date.now }
});
VaultMemberSchema.index({ ownerCustomerId: 1, memberCustomerId: 1 }, { unique: true });
module.exports = mongoose.model('VaultMember', VaultMemberSchema);
