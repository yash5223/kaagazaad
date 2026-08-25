const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const User = require('../models/User');
const Invite = require('../models/Invite');
const VaultMember = require('../models/VaultMember');
const Asset = require('../models/Asset');
const SharedDocument = require('../models/SharedDocument');
const authMiddleware = require('../middleware/authMiddleware');
const { validate, schemas } = require('../middleware/validators');
const { createAlert } = require('./alertRoutes');
const INVITE_EXPIRY_DAYS = 7;
router.use(authMiddleware);
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
router.post('/create-invite', validate(schemas.createInviteBody), async (req, res) => {
  try {
    const { role } = req.body;
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const invite = await Invite.create({
      ownerCustomerId: req.user.customer_id,
      token,
      role,
      expiresAt
    });
    return res.status(201).json({ success: true, invite: serializeInvite(invite, req) });
  } catch (err) {
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.get('/invites', async (req, res) => {
  try {
    await Invite.updateMany(
      { ownerCustomerId: req.user.customer_id, status: 'pending', expiresAt: { $lt: new Date() } },
      { $set: { status: 'revoked' } }
    );
    const invites = await Invite.find({
      ownerCustomerId: req.user.customer_id,
      status: 'pending'
    }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, invites: invites.map(inv => serializeInvite(inv, req)) });
  } catch (err) {
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.delete('/invites/:token', validate(schemas.inviteTokenParam, 'params'), async (req, res) => {
  try {
    const { token } = req.params;
    const invite = await Invite.findOne({ token, ownerCustomerId: req.user.customer_id });
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found.' });
    }
    await Invite.deleteOne({ _id: invite._id });
    return res.status(200).json({ success: true, message: 'Invite revoked.' });
  } catch (err) {
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/join', validate(schemas.joinBody), async (req, res) => {
  try {
    const { token } = req.body;
    const joiner = await User.findById(req.user.id);
    if (!joiner) {
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
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.get('/members', async (req, res) => {
  try {
    const members = await VaultMember.find({ ownerCustomerId: req.user.customer_id }).sort({ joinedAt: -1 });
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
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.delete('/members/:id', validate(schemas.memberIdParam, 'params'), async (req, res) => {
  try {
    const { id } = req.params;
    const member = await VaultMember.findOne({ _id: id, ownerCustomerId: req.user.customer_id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    await VaultMember.deleteOne({ _id: member._id });
    return res.status(200).json({ success: true, message: 'Member removed.' });
  } catch (err) {
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
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
router.post('/share-document', validate(schemas.shareDocumentBody), async (req, res) => {
  try {
    const { assetId, documentPath, documentName, receiver } = req.body;
    const owner = await User.findById(req.user.id);
    if (!owner) {
      return res.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const asset = await Asset.findOne({ _id: assetId, userId: owner.customer_id });
    if (!asset) {
      return res.status(404).json({ error: 'Document not found in your vault.' });
    }
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
    await createAlert({
      title: 'Document Shared With You',
      message: `${owner.fullName || owner.email} shared "${documentName || asset.name}" with you.`,
      type: 'info',
      priority: 'low',
      sent_by: owner.fullName || owner.email,
      sent_to: receiverUser.customer_id,
      related_asset_id: String(assetId),
    });
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
      try {
        const { assetId, receiver } = req.body;
        const owner = await User.findById(req.user.id);
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
      }
      return res.status(409).json({ error: 'This document is already actively shared with that person.' });
    }
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.get('/shared-asset/:assetId', validate(schemas.sharedAssetIdParam, 'params'), async (req, res) => {
  try {
    const { assetId } = req.params;
    const requesterCustomerId = req.user.customer_id;
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'This document is no longer available.' });
    }
    const isOwner = asset.userId === requesterCustomerId;
    if (!isOwner) {
      const activeShare = await SharedDocument.findOne({
        assetId: String(assetId),
        receiverCustomerId: requesterCustomerId,
        status: 'active',
      });
      if (!activeShare) {
        return res.status(403).json({ error: 'This document is no longer shared with you.' });
      }
    }
    return res.status(200).json({ success: true, asset, viewOnly: !isOwner });
  } catch (err) {
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.get('/shared-with-me', async (req, res) => {
  try {
    const shares = await SharedDocument.find({
      $or: [{ receiverCustomerId: req.user.customer_id }, { receiverEmail: req.user.email }],
    }).sort({ sharedAt: -1 });
    return res.status(200).json({ success: true, documents: shares.map(serializeShare) });
  } catch (err) {
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.get('/shared-by-me', async (req, res) => {
  try {
    const shares = await SharedDocument.find({ ownerCustomerId: req.user.customer_id }).sort({ sharedAt: -1 });
    return res.status(200).json({ success: true, documents: shares.map(serializeShare) });
  } catch (err) {
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.delete('/shared/:id', validate(schemas.sharedIdParam, 'params'), async (req, res) => {
  try {
    const { id } = req.params;
    const owner = await User.findById(req.user.id);
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
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
async function resolveVaultAccess(requesterCustomerId, vaultOwnerCustomerId) {
  if (!vaultOwnerCustomerId || vaultOwnerCustomerId === requesterCustomerId) {
    return { ownerCustomerId: requesterCustomerId, role: 'admin' };
  }
  const membership = await VaultMember.findOne({
    ownerCustomerId: vaultOwnerCustomerId,
    memberCustomerId: requesterCustomerId
  });
  if (!membership) return null;
  return { ownerCustomerId: vaultOwnerCustomerId, role: membership.role };
}
module.exports = router;
module.exports.resolveVaultAccess = resolveVaultAccess;