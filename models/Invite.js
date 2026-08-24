const mongoose = require('mongoose');
const InviteSchema = new mongoose.Schema({
  ownerCustomerId: { type: String, required: true },
  token: { type: String, required: true, unique: true },
  role: { type: String, enum: ['view', 'edit', 'admin'], default: 'view' },
  status: { type: String, enum: ['pending', 'accepted', 'revoked'], default: 'pending' },
  acceptedByCustomerId: { type: String, default: null },
  acceptedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Invite', InviteSchema);
