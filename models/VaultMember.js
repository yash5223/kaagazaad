const mongoose = require("mongoose");
const VaultMemberSchema = new mongoose.Schema({
  ownerCustomerId: {
    type: String,
    required: true
  },
  memberCustomerId: {
    type: String,
    required: true
  },
  memberEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  memberName: {
    type: String,
    default: ""
  },
  role: {
    type: String,
    enum: [ "view", "edit", "admin" ],
    default: "view"
  },
  joinedAt: {
    type: Date,
    default: Date.now
  }
});
VaultMemberSchema.plugin(require("../utils/encryptedFields"), {
  collection: "vaultmembers",
  lookups: {ownerCustomerId: {}, memberCustomerId: {}},
  // replaces the old unique {ownerCustomerId, memberCustomerId} index
  composites: [{name: "pairIdx", fields: ["ownerCustomerId", "memberCustomerId"], unique: true}]
});
module.exports = mongoose.model("VaultMember", VaultMemberSchema);
