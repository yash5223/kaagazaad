const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();
const User = require('../models/User');
const Invite = require('../models/Invite');
const VaultMember = require('../models/VaultMember');
const Asset = require('../models/Asset');
const SharedDocument = require('../models/SharedDocument');
const { createAlert } = require('./alertRoutes');
const INVITE_EXPIRY_DAYS = 7;
function buildInviteLink(token, req) {
  const configuredBase = process.env.JOIN_LINK_BASE;
  if (configuredBase) {
    return `${configuredBase.replace(/\/+$/, '')}/${token}`;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/join/${token}`;
}
function serializeInvite(invite, req) {
  return {
    id: invite._id,
    token: invite.token,
    link: buildInviteLink(invite.token, req),
    role: invite.role,
    status: invite.status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt
  };
}
router.post('/create-invite', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) {
      return res.status(401).json({ error: 'Authentication credentials required.' });
    }
    if (!['view', 'edit', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Role must be view, edit, or admin.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const isPasswordValid = await bcrypt.compare(password, owner.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const invite = await Invite.create({
      ownerCustomerId: owner.customer_id,
      token,
      role,
      expiresAt
    });
    return res.status(201).json({ success: true, invite: serializeInvite(invite, req) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.get('/invites', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    await Invite.updateMany(
      { ownerCustomerId: owner.customer_id, status: 'pending', expiresAt: { $lt: new Date() } },
      { $set: { status: 'revoked' } }
    );
    const invites = await Invite.find({
      ownerCustomerId: owner.customer_id,
      status: 'pending'
    }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, invites: invites.map(inv => serializeInvite(inv, req)) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.delete('/invites/:token', async (req, res) => {
  try {
    const { email } = req.query;
    const { token } = req.params;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const invite = await Invite.findOne({ token, ownerCustomerId: owner.customer_id });
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found.' });
    }
    await Invite.deleteOne({ _id: invite._id });
    return res.status(200).json({ success: true, message: 'Invite revoked.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.post('/join', async (req, res) => {
  try {
    const { token, email, password } = req.body;
    if (!token || !email || !password) {
      return res.status(400).json({ error: 'Token, email and password are required.' });
    }
    const joiner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!joiner) {
      return res.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const isPasswordValid = await bcrypt.compare(password, joiner.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const invite = await Invite.findOne({ token });
    if (!invite || invite.status !== 'pending') {
      return res.status(404).json({ error: 'This invite link is invalid or has already been used.' });
    }
    if (invite.expiresAt < new Date()) {
      invite.status = 'revoked';
      await invite.save();
      return res.status(410).json({ error: 'This invite link has expired.' });
    }
    if (invite.ownerCustomerId === joiner.customer_id) {
      return res.status(400).json({ error: "You can't join your own vault." });
    }
    const existingMembership = await VaultMember.findOne({
      ownerCustomerId: invite.ownerCustomerId,
      memberCustomerId: joiner.customer_id
    });
    if (existingMembership) {
      existingMembership.role = invite.role;
      await existingMembership.save();
    } else {
      await VaultMember.create({
        ownerCustomerId: invite.ownerCustomerId,
        memberCustomerId: joiner.customer_id,
        memberEmail: joiner.email,
        memberName: joiner.fullName,
        role: invite.role
      });
    }
    invite.status = 'accepted';
    invite.acceptedByCustomerId = joiner.customer_id;
    invite.acceptedAt = new Date();
    await invite.save();
    const owner = await User.findOne({ customer_id: invite.ownerCustomerId });
    return res.status(200).json({
      success: true,
      message: 'You have joined the vault.',
      vault: { ownerCustomerId: invite.ownerCustomerId, ownerName: owner ? owner.fullName : '', role: invite.role }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// 5. LIST MEMBERS OF A VAULT
router.get('/members', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const members = await VaultMember.find({ ownerCustomerId: owner.customer_id }).sort({ joinedAt: -1 });
    return res.status(200).json({
      success: true,
      members: members.map(m => ({
        id: m._id,
        name: m.memberName,
        email: m.memberEmail,
        role: m.role,
        joinedAt: m.joinedAt
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.delete('/members/:id', async (req, res) => {
  try {
    const { email } = req.query;
    const { id } = req.params;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const member = await VaultMember.findOne({ _id: id, ownerCustomerId: owner.customer_id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    await VaultMember.deleteOne({ _id: member._id });
    return res.status(200).json({ success: true, message: 'Member removed.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
function serializeShare(share) {
  return {
    id: share._id,
    assetId: share.assetId,
    documentPath: share.documentPath,
    documentName: share.documentName,
    category: share.category,
    subCategory: share.subCategory,
    subSubCategory: share.subSubCategory,
    ownerName: share.ownerName,
    ownerEmail: share.ownerEmail,
    receiverName: share.receiverName,
    receiverEmail: share.receiverEmail,
    status: share.status || 'active',
    sharedAt: share.sharedAt,
    revokedAt: share.revokedAt || null,
  };
}

// 6. SHARE A DOCUMENT (ASSET) WITH ANOTHER USER
router.post('/share-document', async (req, res) => {
  try {
    const { email, password, assetId, documentPath, documentName, receiver } = req.body;
    if (!email || !password) {
      return res.status(401).json({ error: 'Authentication credentials required.' });
    }
    if (!assetId || !receiver) {
      return res.status(400).json({ error: 'Asset and receiver are required.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const isPasswordValid = await bcrypt.compare(password, owner.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const asset = await Asset.findOne({ _id: assetId, userId: owner.customer_id });
    if (!asset) {
      return res.status(404).json({ error: 'Document not found in your vault.' });
    }
    // The whole asset is shared as a single unit — documentPath (if provided) is
    // only kept around for a display thumbnail, it no longer identifies the share.
    const primaryDocumentPath =
      documentPath && (asset.documents || []).includes(documentPath)
        ? documentPath
        : (asset.documents || []).find((d) => d && d !== '-') || '';
    const receiverKey = receiver.trim().toLowerCase();
    const receiverUser = await User.findOne({
      $or: [{ email: receiverKey }, { phone: receiver.trim() }],
    });
    if (!receiverUser) {
      return res.status(404).json({ error: 'No Kaagazaad account was found with that email or phone number.' });
    }
    if (receiverUser.customer_id === owner.customer_id) {
      return res.status(400).json({ error: "You can't share a document with yourself." });
    }
    // Every share action gets recorded as its own history row for both sides.
    // If there's already an ACTIVE share of this asset to this receiver, don't
    // duplicate it — just touch it. Otherwise (first time, or re-sharing after
    // a previous revoke) create a brand new row, so past share/revoke cycles
    // stay intact in history instead of being overwritten.
    const existingActiveShare = await SharedDocument.findOne({
      ownerCustomerId: owner.customer_id,
      receiverEmail: receiverUser.email,
      assetId: String(assetId),
      status: 'active',
    });
    const shareFields = {
      ownerCustomerId: owner.customer_id,
      ownerName: owner.fullName || owner.email,
      ownerEmail: owner.email,
      receiverCustomerId: receiverUser.customer_id,
      receiverEmail: receiverUser.email,
      receiverName: receiverUser.fullName || receiverUser.email,
      assetId: String(assetId),
      documentPath: primaryDocumentPath,
      documentName: documentName || asset.name,
      category: asset.category,
      subCategory: asset.subCategory,
      subSubCategory: asset.subSubCategory,
      status: 'active',
      sharedAt: new Date(),
      revokedAt: null,
    };
    let share;
    if (existingActiveShare) {
      existingActiveShare.set(shareFields);
      share = await existingActiveShare.save();
    } else {
      share = await SharedDocument.create(shareFields);
    }
    // Notify the receiver that a document was shared with them.
    await createAlert({
      title: 'Document Shared With You',
      message: `${owner.fullName || owner.email} shared "${documentName || asset.name}" with you.`,
      type: 'info',
      priority: 'low',
      sent_by: owner.fullName || owner.email,
      sent_to: receiverUser.customer_id,
      related_asset_id: String(assetId),
    });
    // Notify the sender/owner as confirmation that the share went through.
    await createAlert({
      title: 'Document Shared',
      message: `You shared "${documentName || asset.name}" with ${receiverUser.fullName || receiverUser.email}.`,
      type: 'success',
      priority: 'low',
      sent_by: 'System',
      sent_to: owner.customer_id,
      related_asset_id: String(assetId),
    });
    return res.status(201).json({ success: true, message: 'Document shared successfully.', share: serializeShare(share) });
  } catch (err) {
    if (err && err.code === 11000) {
      // Only the ACTIVE-share uniqueness should ever legitimately race here
      // (two share taps at once). Fetch that active row and return it, rather
      // than silently pretending the request succeeded with no data to show.
      try {
        const { email, assetId, receiver } = req.body;
        const owner = await User.findOne({ email: (email || '').toLowerCase().trim() });
        const receiverUser = await User.findOne({
          $or: [{ email: (receiver || '').trim().toLowerCase() }, { phone: (receiver || '').trim() }],
        });
        const existing = owner && receiverUser
          ? await SharedDocument.findOne({
            ownerCustomerId: owner.customer_id,
            receiverEmail: receiverUser.email,
            assetId: String(assetId),
            status: 'active',
          })
          : null;
        if (existing) {
          return res.status(200).json({ success: true, message: 'Document shared successfully.', share: serializeShare(existing) });
        }
      } catch (_) {
        // fall through to the generic error below
      }
      return res.status(409).json({ error: 'This document is already actively shared with that person.' });
    }
    return res.status(500).json({ error: err.message });
  }
});

// 6b. FETCH THE FULL ASSET BEHIND A SHARE (view-only — used by the "View" button)
router.get('/shared-asset/:assetId', async (req, res) => {
  try {
    const { assetId } = req.params;
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const requester = await User.findOne({ email: email.toLowerCase().trim() });
    if (!requester) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'This document is no longer available.' });
    }
    // The owner can always view their own asset, whether or not the share is
    // still active. A receiver, however, only gets access while the share is
    // active — once the owner stops sharing, the receiver loses the view.
    const isOwner = asset.userId === requester.customer_id;
    if (!isOwner) {
      const activeShare = await SharedDocument.findOne({
        assetId: String(assetId),
        receiverCustomerId: requester.customer_id,
        status: 'active',
      });
      if (!activeShare) {
        return res.status(403).json({ error: 'This document is no longer shared with you.' });
      }
    }
    // viewOnly always true from this endpoint — the receiver (or a re-viewing
    // sender) can look at every field, but the client must not expose
    // edit/add/delete actions unless the requester is actually the owner.
    return res.status(200).json({ success: true, asset, viewOnly: !isOwner });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 7. LIST DOCUMENTS SHARED WITH THE CURRENT USER (received — includes history of revoked shares)
router.get('/shared-with-me', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const shares = await SharedDocument.find({
      $or: [{ receiverCustomerId: user.customer_id }, { receiverEmail: user.email }],
    }).sort({ sharedAt: -1 });
    return res.status(200).json({ success: true, documents: shares.map(serializeShare) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 8. LIST DOCUMENTS THE CURRENT USER HAS SHARED OUT (sent — includes history of revoked shares)
router.get('/shared-by-me', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const shares = await SharedDocument.find({ ownerCustomerId: owner.customer_id }).sort({ sharedAt: -1 });
    return res.status(200).json({ success: true, documents: shares.map(serializeShare) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 9. REVOKE A SHARE (stop sharing a document, keeping it in history)
router.delete('/shared/:id', async (req, res) => {
  try {
    const { email } = req.query;
    const { id } = req.params;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const owner = await User.findOne({ email: email.toLowerCase().trim() });
    if (!owner) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const share = await SharedDocument.findOne({ _id: id, ownerCustomerId: owner.customer_id });
    if (!share) {
      return res.status(404).json({ error: 'Shared document not found.' });
    }
    share.status = 'revoked';
    share.revokedAt = new Date();
    await share.save();

    // Notify the receiver that access to the document has been revoked.
    if (share.receiverCustomerId) {
      await createAlert({
        title: 'Document Access Revoked',
        message: `${owner.fullName || owner.email} stopped sharing "${share.documentName}" with you.`,
        type: 'warning',
        priority: 'low',
        sent_by: owner.fullName || owner.email,
        sent_to: share.receiverCustomerId,
        related_asset_id: share.assetId,
      });
    }
    // Notify the owner/sender as confirmation that sharing was stopped.
    await createAlert({
      title: 'Stopped Sharing Document',
      message: `You stopped sharing "${share.documentName}" with ${share.receiverName || share.receiverEmail}.`,
      type: 'info',
      priority: 'low',
      sent_by: 'System',
      sent_to: owner.customer_id,
      related_asset_id: share.assetId,
    });

    return res.status(200).json({ success: true, message: 'Stopped sharing this document.', share: serializeShare(share) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function resolveVaultAccess(email, vaultOwnerCustomerId) {
  const requester = await User.findOne({ email: email.toLowerCase().trim() });
  if (!requester) return null;
  if (!vaultOwnerCustomerId || vaultOwnerCustomerId === requester.customer_id) {
    return { ownerCustomerId: requester.customer_id, role: 'admin', requester };
  }
  const membership = await VaultMember.findOne({
    ownerCustomerId: vaultOwnerCustomerId,
    memberCustomerId: requester.customer_id
  });
  if (!membership) return null;
  return { ownerCustomerId: vaultOwnerCustomerId, role: membership.role, requester };
}
module.exports = router;
module.exports.resolveVaultAccess = resolveVaultAccess;