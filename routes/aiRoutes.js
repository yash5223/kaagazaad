const express = require("express");
const {reportError: reportError} = require("../utils/monitoring");
const router = express.Router();
const mongoose = require("mongoose");
const User = require("../models/User");
const Asset = require("../models/Asset");
const SharedDocument = require("../models/SharedDocument");
const authMiddleware = require("../middleware/authMiddleware");
const {requireActivePlan: requireActivePlan, requireAiQuota: requireAiQuota} = require("../middleware/planGuard");
const {generateReply: generateReply, generateAssetSummary: generateAssetSummary, generateWarrantyClaimEmail: generateWarrantyClaimEmail} = require("../utils/aiEngine");
router.use(authMiddleware);
router.use(require("../middleware/rateLimiters").aiLimiter);
router.use(requireActivePlan);
async function resolveAssetForAi(assetId, userMatch) {
  const owned = (await Asset.findOne({
    _id: assetId,
    userId: userMatch.customer_id
  }).lean());
  if (owned) return owned;
  const share = (await SharedDocument.find({
    assetId: String(assetId),
    $or: [ {
      receiverCustomerId: userMatch.customer_id
    }, {
      ownerCustomerId: userMatch.customer_id
    } ]
  })).find(sh => sh.status === "active");
  if (!share) return null;
  return await Asset.findById(assetId).lean();
}
// E2EE records are opaque to the server. For these features the app may, after the user
// consents on-device, send the already-decrypted fields of ONLY the records involved. They are
// used for this single request (a local template engine, no third party) and never stored/logged.
function clientSuppliedAsset(body) {
  const a = body && body.clientAsset;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  if (JSON.stringify(a).length > 20000) return null;
  return a;
}
function clientSuppliedAssets(body) {
  const list = body && body.clientAssets;
  if (!Array.isArray(list) || list.length > 200) return null;
  if (JSON.stringify(list).length > 400000) return null;
  return list.filter(a => a && typeof a === "object" && !Array.isArray(a));
}
router.post("/chat", requireAiQuota, async (req, res) => {
  try {
    const {message: message} = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "A valid message is required."
      });
    }
    const userMatch = await User.findById(req.user.id);
    if (!userMatch) {
      return res.status(404).json({
        error: "User account not found."
      });
    }
    const assets = clientSuppliedAssets(req.body) || (await Asset.find({
      userId: userMatch.customer_id
    }).lean());
    const reply = generateReply(message.trim(), assets);
    return res.status(200).json({
      success: true,
      reply: reply
    });
  } catch (err) {
    reportError(err, {where: "ai_chat", req: req});
    return res.status(500).json({
      error: "Internal server error during chat processing."
    });
  }
});
router.post("/summary", requireAiQuota, async (req, res) => {
  try {
    const {assetId: assetId} = req.body;
    const cleanId = assetId ? assetId.trim() : null;
    const supplied = clientSuppliedAsset(req.body);
    if (!cleanId && !supplied) {
      return res.status(400).json({
        error: "assetId is required."
      });
    }
    if (cleanId && !mongoose.Types.ObjectId.isValid(cleanId)) {
      return res.status(400).json({
        error: "Invalid asset ID format."
      });
    }
    const userMatch = await User.findById(req.user.id);
    if (!userMatch) {
      return res.status(404).json({
        error: "User account not found."
      });
    }
    const asset = supplied || await resolveAssetForAi(cleanId, userMatch);
    if (!asset) {
      return res.status(404).json({
        error: "Asset not found or access denied."
      });
    }
    const summary = generateAssetSummary(asset);
    return res.status(200).json({
      success: true,
      summary: summary
    });
  } catch (err) {
    reportError(err, {where: "ai_summary", req: req});
    return res.status(500).json({
      error: "Internal server error while generating summary."
    });
  }
});
router.post("/warranty-email", requireAiQuota, async (req, res) => {
  try {
    const {assetId: assetId} = req.body;
    const cleanId = assetId ? assetId.trim() : null;
    const supplied = clientSuppliedAsset(req.body);
    if (!cleanId && !supplied) {
      return res.status(400).json({
        error: "assetId is required."
      });
    }
    if (cleanId && !mongoose.Types.ObjectId.isValid(cleanId)) {
      return res.status(400).json({
        error: "Invalid asset ID format."
      });
    }
    const userMatch = await User.findById(req.user.id);
    if (!userMatch) {
      return res.status(404).json({
        error: "User account not found."
      });
    }
    const asset = supplied || await resolveAssetForAi(cleanId, userMatch);
    if (!asset) {
      return res.status(404).json({
        error: "Asset not found or access denied."
      });
    }
    const {subject: subject, body: body} = generateWarrantyClaimEmail(asset, userMatch);
    return res.status(200).json({
      success: true,
      subject: subject,
      body: body
    });
  } catch (err) {
    reportError(err, {where: "ai_warranty_email", req: req});
    return res.status(500).json({
      error: "Internal server error while generating warranty claim email."
    });
  }
});
module.exports = router;
