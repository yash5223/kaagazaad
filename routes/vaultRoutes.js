const express = require("express");
const {reportError: reportError} = require("../utils/monitoring");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const {hashSecret: hashSecret} = require("../utils/passwordHash");
const router = express.Router();
const User = require("../models/User");
const Invite = require("../models/Invite");
const VaultMember = require("../models/VaultMember");
const Asset = require("../models/Asset");
const SharedDocument = require("../models/SharedDocument");
const authMiddleware = require("../middleware/authMiddleware");
const {requireActivePlan: requireActivePlan, requireFeature: requireFeature} = require("../middleware/planGuard");
const {checkAccess: checkAccess, sendPlanLimit: sendPlanLimit} = require("../utils/planLimits");
const {validate: validate, schemas: schemas} = require("../middleware/validators");
const {joinLimiter: joinLimiter} = require("../middleware/rateLimiters");
const {createAlert: createAlert} = require("./alertRoutes");
const {documentEntryMatches: documentEntryMatches, resolveDocumentUrl: resolveDocumentUrl} = require("../utils/cloudinary");
const INVITE_EXPIRY_DAYS = 7;
router.use(authMiddleware);
router.use(requireActivePlan);
function buildInviteLink(token, req) {
  const configuredBase = process.env.JOIN_LINK_BASE;
  if (configuredBase) {
    return `${configuredBase.replace(/\/+$/, "")}/${token}`;
  }
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
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
router.post("/create-invite", requireFeature("familyVault"), validate(schemas.createInviteBody), async (req, res) => {
  try {
    const {role: role} = req.body;
    const planKey = req.planUser ? req.planUser.subscription_plan : null;
    const pendingInvites = (await Invite.find({ ownerCustomerId: req.user.customer_id })).filter(i => i.status === "pending" && i.expiresAt > new Date);
    const seatsUsed = (await VaultMember.countDocuments({ ownerCustomerId: req.user.customer_id })) + pendingInvites.length;
    const seat = checkAccess(planKey, "familyMembers", seatsUsed);
    if (!seat.allowed) return sendPlanLimit(res, planKey, "familyMembers", seat.limit);
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1e3);
    const invite = await Invite.create({
      ownerCustomerId: req.user.customer_id,
      token: token,
      role: role,
      expiresAt: expiresAt
    });
    return res.status(201).json({
      success: true,
      invite: serializeInvite(invite, req)
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.get("/invites", async (req, res) => {
  try {
    const ownInvites = await Invite.find({
      ownerCustomerId: req.user.customer_id
    }).sort({
      createdAt: -1
    });
    const now = new Date;
    for (const inv of ownInvites) {
      if (inv.status === "pending" && inv.expiresAt < now) {
        inv.status = "revoked";
        await inv.save();
      }
    }
    const invites = ownInvites.filter(inv => inv.status === "pending");
    return res.status(200).json({
      success: true,
      invites: invites.map(inv => serializeInvite(inv, req))
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.delete("/invites/:token", validate(schemas.inviteTokenParam, "params"), async (req, res) => {
  try {
    const {token: token} = req.params;
    const invite = await Invite.findOne({
      token: token,
      ownerCustomerId: req.user.customer_id
    });
    if (!invite) {
      return res.status(404).json({
        error: "Invite not found."
      });
    }
    await Invite.deleteOne({
      _id: invite._id
    });
    return res.status(200).json({
      success: true,
      message: "Invite revoked."
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/join", joinLimiter, validate(schemas.joinBody), async (req, res) => {
  try {
    const {token: token} = req.body;
    const joiner = await User.findById(req.user.id);
    if (!joiner) {
      return res.status(401).json({
        error: "Invalid user account credentials."
      });
    }
    const invite = await Invite.findOne({
      token: token
    });
    if (!invite || invite.status !== "pending") {
      return res.status(404).json({
        error: "This invite link is invalid or has already been used."
      });
    }
    if (invite.expiresAt < new Date) {
      invite.status = "revoked";
      await invite.save();
      return res.status(410).json({
        error: "This invite link has expired."
      });
    }
    if (invite.ownerCustomerId === joiner.customer_id) {
      return res.status(400).json({
        error: "You can't join your own vault."
      });
    }
    const existingMembership = await VaultMember.findOne({
      ownerCustomerId: invite.ownerCustomerId,
      memberCustomerId: joiner.customer_id
    });
    if (!existingMembership) {
      const owner = await User.findOne({ customer_id: invite.ownerCustomerId }).select("subscription_plan");
      const taken = await VaultMember.countDocuments({ ownerCustomerId: invite.ownerCustomerId });
      if (owner && !checkAccess(owner.subscription_plan, "familyMembers", taken).allowed) {
        return res.status(403).json({ error: "This family vault is full. Ask the owner to free up a seat." });
      }
    }
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
    invite.status = "accepted";
    invite.acceptedByCustomerId = joiner.customer_id;
    invite.acceptedAt = new Date;
    await invite.save();
    const owner = await User.findOne({
      customer_id: invite.ownerCustomerId
    });
    return res.status(200).json({
      success: true,
      message: "You have joined the vault.",
      vault: {
        ownerCustomerId: invite.ownerCustomerId,
        ownerName: owner ? owner.fullName : "",
        role: invite.role
      }
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.get("/members", async (req, res) => {
  try {
    const members = (await VaultMember.find({
      ownerCustomerId: req.user.customer_id
    })).sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
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
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.delete("/members/:id", validate(schemas.memberIdParam, "params"), async (req, res) => {
  try {
    const {id: id} = req.params;
    const member = await VaultMember.findOne({
      _id: id,
      ownerCustomerId: req.user.customer_id
    });
    if (!member) {
      return res.status(404).json({
        error: "Member not found."
      });
    }
    await VaultMember.deleteOne({
      _id: member._id
    });
    return res.status(200).json({
      success: true,
      message: "Member removed."
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
function isExpired(share) {
  return !!(share && share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now());
}
function effectiveStatus(share) {
  const status = share.status || "active";
  if (status === "active" && isExpired(share)) return "expired";
  return status;
}
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
    receiverPhone: share.receiverPhone || "",
    recipientLabel: share.recipientLabel || "",
    status: effectiveStatus(share),
    sharedAt: share.sharedAt,
    revokedAt: share.revokedAt || null,
    expiresAt: share.expiresAt || null,
    viewOnly: share.viewOnly !== false,
    requiresPin: !!share.requiresPin,
    watermarkText: share.watermarkText || "",
    firstViewedAt: share.firstViewedAt || null,
    lastViewedAt: share.lastViewedAt || null,
    viewCount: share.viewCount || 0
  };
}
router.post("/share-document", requireFeature("share"), validate(schemas.shareDocumentBody), async (req, res) => {
  try {
    const {assetId: assetId, documentPath: documentPath, documentName: documentName, receiver: receiver, recipientLabel: recipientLabel, expiresInMinutes: expiresInMinutes, viewOnly: viewOnly, pin: pin, watermarkText: watermarkText} = req.body;
    const owner = await User.findById(req.user.id);
    if (!owner) {
      return res.status(401).json({
        error: "Invalid user account credentials."
      });
    }
    const asset = await Asset.findOne({
      _id: assetId,
      userId: owner.customer_id
    });
    if (!asset) {
      return res.status(404).json({
        error: "Document not found in your vault."
      });
    }
    if (asset.e2ee) {
      return res.status(409).json({
        error: "End-to-end encrypted documents can't be shared through the server yet, because the server has no key to open them.",
        code: "E2EE_NOT_SHAREABLE"
      });
    }
    const assetDocuments = asset.documents || [];
    const matchedEntry = documentPath && assetDocuments.find(d => documentEntryMatches(d, documentPath)) || assetDocuments.find(d => d && d !== "-") || null;
    const primaryDocumentPath = matchedEntry ? resolveDocumentUrl(matchedEntry) || "" : "";
    const receiverKey = receiver.trim().toLowerCase();
    const receiverUser = await User.findOne({
      $or: [ {
        email: receiverKey
      }, {
        phone: receiver.trim()
      } ]
    });
    if (!receiverUser) {
      return res.status(404).json({
        error: "No Kaagazaad account was found with that email or phone number."
      });
    }
    if (receiverUser.customer_id === owner.customer_id) {
      return res.status(400).json({
        error: "You can't share a document with yourself."
      });
    }
    const existingActiveShare = (await SharedDocument.find({
      ownerCustomerId: owner.customer_id,
      receiverEmail: receiverUser.email,
      assetId: String(assetId)
    })).find(sh => sh.status === "active") || null;
    const shareFields = {
      ownerCustomerId: owner.customer_id,
      ownerName: owner.fullName || owner.email,
      ownerEmail: owner.email,
      receiverCustomerId: receiverUser.customer_id,
      receiverEmail: receiverUser.email,
      receiverName: receiverUser.fullName || receiverUser.email,
      receiverPhone: receiverUser.phone || "",
      recipientLabel: (recipientLabel || "").trim(),
      expiresAt: expiresInMinutes ? new Date(Date.now() + expiresInMinutes * 60 * 1e3) : null,
      viewOnly: viewOnly !== false,
      requiresPin: !!pin,
      pinHash: pin ? await hashSecret(pin) : "",
      watermarkText: (watermarkText || "").trim(),
      firstViewedAt: null,
      lastViewedAt: null,
      viewCount: 0,
      assetId: String(assetId),
      documentPath: primaryDocumentPath,
      documentName: documentName || asset.name,
      category: asset.category,
      subCategory: asset.subCategory,
      subSubCategory: asset.subSubCategory,
      status: "active",
      sharedAt: new Date,
      revokedAt: null
    };
    let share;
    if (existingActiveShare) {
      existingActiveShare.set(shareFields);
      share = await existingActiveShare.save();
    } else {
      share = await SharedDocument.create(shareFields);
    }
    await createAlert({
      title: "Document Shared With You",
      message: `${owner.fullName || owner.email} shared "${documentName || asset.name}" with you.`,
      type: "info",
      priority: "low",
      sent_by: owner.fullName || owner.email,
      sent_to: receiverUser.customer_id,
      related_asset_id: String(assetId)
    });
    await createAlert({
      title: "Document Shared",
      message: `You shared "${documentName || asset.name}" with ${receiverUser.fullName || receiverUser.email}.`,
      type: "success",
      priority: "low",
      sent_by: "System",
      sent_to: owner.customer_id,
      related_asset_id: String(assetId)
    });
    return res.status(201).json({
      success: true,
      message: "Document shared successfully.",
      share: serializeShare(share)
    });
  } catch (err) {
    if (err && err.code === 11e3) {
      try {
        const {assetId: assetId, receiver: receiver} = req.body;
        const owner = await User.findById(req.user.id);
        const receiverUser = await User.findOne({
          $or: [ {
            email: (receiver || "").trim().toLowerCase()
          }, {
            phone: (receiver || "").trim()
          } ]
        });
        const existing = owner && receiverUser ? (await SharedDocument.find({
          ownerCustomerId: owner.customer_id,
          receiverEmail: receiverUser.email,
          assetId: String(assetId)
        })).find(sh => sh.status === "active") || null : null;
        if (existing) {
          return res.status(200).json({
            success: true,
            message: "Document shared successfully.",
            share: serializeShare(existing)
          });
        }
      } catch (_) {}
      return res.status(409).json({
        error: "This document is already actively shared with that person."
      });
    }
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.get("/shared-asset/:assetId", validate(schemas.sharedAssetIdParam, "params"), async (req, res) => {
  try {
    const {assetId: assetId} = req.params;
    const requesterCustomerId = req.user.customer_id;
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({
        error: "This document is no longer available."
      });
    }
    const isOwner = asset.userId === requesterCustomerId;
    let activeShare = null;
    if (!isOwner) {
      activeShare = (await SharedDocument.find({
        assetId: String(assetId),
        receiverCustomerId: requesterCustomerId
      }).select("+pinHash")).find(sh => sh.status === "active") || null;
      if (!activeShare) {
        return res.status(403).json({
          error: "This document is no longer shared with you."
        });
      }
      if (isExpired(activeShare)) {
        return res.status(403).json({
          error: "This shared link has expired."
        });
      }
      if (activeShare.requiresPin) {
        const suppliedPin = String(req.query.pin || "");
        if (!suppliedPin) {
          return res.status(403).json({
            error: "This document is protected. Enter the PIN the sender gave you.",
            pinRequired: true
          });
        }
        const pinOk = await bcrypt.compare(suppliedPin, activeShare.pinHash || "");
        if (!pinOk) {
          return res.status(403).json({
            error: "Incorrect PIN.",
            pinRequired: true
          });
        }
      }
      const now = new Date;
      const isFirstView = !activeShare.firstViewedAt;
      activeShare.lastViewedAt = now;
      if (isFirstView) activeShare.firstViewedAt = now;
      activeShare.viewCount = (activeShare.viewCount || 0) + 1;
      await activeShare.save();
      if (isFirstView) {
        try {
          await createAlert({
            title: "Document Opened",
            message: `${activeShare.receiverName || activeShare.receiverEmail} opened "${activeShare.documentName}" you shared.`,
            type: "info",
            priority: "low",
            sent_by: "System",
            sent_to: activeShare.ownerCustomerId,
            related_asset_id: String(assetId)
          });
        } catch (_) {}
      }
    }
    return res.status(200).json({
      success: true,
      asset: asset,
      viewOnly: !isOwner && (!activeShare || activeShare.viewOnly !== false),
      watermarkText: activeShare ? activeShare.watermarkText || "" : ""
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.get("/shared-with-me", async (req, res) => {
  try {
    const shares = (await SharedDocument.find({
      $or: [ {
        receiverCustomerId: req.user.customer_id
      }, {
        receiverEmail: req.user.email
      } ]
    })).sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));
    return res.status(200).json({
      success: true,
      documents: shares.map(serializeShare)
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.get("/shared-by-me", async (req, res) => {
  try {
    const shares = (await SharedDocument.find({
      ownerCustomerId: req.user.customer_id
    })).sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));
    return res.status(200).json({
      success: true,
      documents: shares.map(serializeShare)
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.delete("/shared/:id", validate(schemas.sharedIdParam, "params"), async (req, res) => {
  try {
    const {id: id} = req.params;
    const owner = await User.findById(req.user.id);
    if (!owner) {
      return res.status(404).json({
        error: "User account profile not found."
      });
    }
    const share = await SharedDocument.findOne({
      _id: id,
      ownerCustomerId: owner.customer_id
    });
    if (!share) {
      return res.status(404).json({
        error: "Shared document not found."
      });
    }
    share.status = "revoked";
    share.revokedAt = new Date;
    await share.save();
    if (share.receiverCustomerId) {
      await createAlert({
        title: "Document Access Revoked",
        message: `${owner.fullName || owner.email} stopped sharing "${share.documentName}" with you.`,
        type: "warning",
        priority: "low",
        sent_by: owner.fullName || owner.email,
        sent_to: share.receiverCustomerId,
        related_asset_id: share.assetId
      });
    }
    await createAlert({
      title: "Stopped Sharing Document",
      message: `You stopped sharing "${share.documentName}" with ${share.receiverName || share.receiverEmail}.`,
      type: "info",
      priority: "low",
      sent_by: "System",
      sent_to: owner.customer_id,
      related_asset_id: share.assetId
    });
    return res.status(200).json({
      success: true,
      message: "Stopped sharing this document.",
      share: serializeShare(share)
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
async function resolveVaultAccess(requesterCustomerId, vaultOwnerCustomerId) {
  if (!vaultOwnerCustomerId || vaultOwnerCustomerId === requesterCustomerId) {
    return {
      ownerCustomerId: requesterCustomerId,
      role: "admin"
    };
  }
  const membership = await VaultMember.findOne({
    ownerCustomerId: vaultOwnerCustomerId,
    memberCustomerId: requesterCustomerId
  });
  if (!membership) return null;
  return {
    ownerCustomerId: vaultOwnerCustomerId,
    role: membership.role
  };
}
module.exports = router;
module.exports.resolveVaultAccess = resolveVaultAccess;
