const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const Asset = require('../models/Asset');
const SharedDocument = require('../models/SharedDocument');
const authMiddleware = require('../middleware/authMiddleware');
const { generateReply, generateAssetSummary, generateWarrantyClaimEmail } = require('../utils/aiEngine');
router.use(authMiddleware);
async function resolveAssetForAi(assetId, userMatch) {
  const owned = await Asset.findOne({ _id: assetId, userId: userMatch.customer_id }).lean();
  if (owned) return owned;
  const share = await SharedDocument.findOne({
    assetId: String(assetId),
    status: 'active',
    $or: [{ receiverCustomerId: userMatch.customer_id }, { ownerCustomerId: userMatch.customer_id }],
  });
  if (!share) return null;
  return Asset.findById(assetId).lean();
}
router.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A valid message is required.' });
    }
    const userMatch = await User.findById(req.user.id);
    if (!userMatch) {
      return res.status(404).json({ error: 'User account not found.' });
    }
    const assets = await Asset.find({ userId: userMatch.customer_id }).lean();
    const reply = generateReply(message.trim(), assets);
    return res.status(200).json({ success: true, reply });
  } catch (err) {
    console.error("AI Chat Error:", err);
    return res.status(500).json({ error: 'Internal server error during chat processing.' });
  }
});
router.post('/summary', async (req, res) => {
  try {
    const { assetId } = req.body;
    const cleanId = assetId ? assetId.trim() : null;
    if (!cleanId) {
      return res.status(400).json({ error: 'assetId is required.' });
    }
    if (!mongoose.Types.ObjectId.isValid(cleanId)) {
      return res.status(400).json({ error: 'Invalid asset ID format.' });
    }
    const userMatch = await User.findById(req.user.id);
    if (!userMatch) {
      return res.status(404).json({ error: 'User account not found.' });
    }
    const asset = await resolveAssetForAi(cleanId, userMatch);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found or access denied.' });
    }
    const summary = generateAssetSummary(asset);
    return res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error("AI Summary Route Error:", err);
    return res.status(500).json({ error: 'Internal server error while generating summary.' });
  }
});
router.post('/warranty-email', async (req, res) => {
  try {
    const { assetId } = req.body;
    const cleanId = assetId ? assetId.trim() : null;
    if (!cleanId) {
      return res.status(400).json({ error: 'assetId is required.' });
    }
    if (!mongoose.Types.ObjectId.isValid(cleanId)) {
      return res.status(400).json({ error: 'Invalid asset ID format.' });
    }
    const userMatch = await User.findById(req.user.id);
    if (!userMatch) {
      return res.status(404).json({ error: 'User account not found.' });
    }
    const asset = await resolveAssetForAi(cleanId, userMatch);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found or access denied.' });
    }
    const { subject, body } = generateWarrantyClaimEmail(asset, userMatch);
    return res.status(200).json({ success: true, subject, body });
  } catch (err) {
    console.error("AI Warranty Email Route Error:", err);
    return res.status(500).json({ error: 'Internal server error while generating warranty claim email.' });
  }
});
module.exports = router;