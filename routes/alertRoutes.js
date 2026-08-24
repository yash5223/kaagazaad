const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Alert = require('../models/Alert');

async function createAlert({ title, message, type = 'info', priority = 'medium', sent_by = 'System', sent_to, related_asset_id = null }) {
  try {
    if (!sent_to) return null;
    const alert = new Alert({ title, message, type, priority, sent_by, sent_to, related_asset_id });
    await alert.save();
    return alert;
  } catch (err) {
    console.error('createAlert error:', err.message);
    return null;
  }
}

async function checkExpiryAlerts(userMatch, assets) {
  try {
    const now = new Date();
    for (const asset of assets) {
      if (!asset.expiryDate) continue;
      const expiry = new Date(asset.expiryDate);
      if (isNaN(expiry.getTime())) continue;
      const diffDays = Math.floor((expiry - now) / (1000 * 60 * 60 * 24));
      let title = null;
      let type = 'reminder';
      let priority = 'medium';
      if (diffDays < 0) {
        title = 'Document Expired';
        type = 'error';
        priority = 'high';
      } else if (diffDays <= 30) {
        title = 'Document Expiring Soon';
        type = 'reminder';
        priority = diffDays <= 7 ? 'high' : 'medium';
      } else {
        continue;
      }
      const existing = await Alert.findOne({
        sent_to: userMatch.customer_id,
        related_asset_id: asset._id.toString(),
        title,
      });
      if (existing) continue;
      const message = diffDays < 0
        ? `"${asset.name}" expired ${Math.abs(diffDays)} day(s) ago.`
        : `"${asset.name}" expires in ${diffDays} day(s).`;
      await createAlert({
        title,
        message,
        type,
        priority,
        sent_by: 'System',
        sent_to: userMatch.customer_id,
        related_asset_id: asset._id.toString(),
      });
    }
  } catch (err) {
    console.error('checkExpiryAlerts error:', err.message);
  }
}

router.get('/fetch-alerts', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required.' });
    }
    const userMatch = await User.findOne({ email: email.toLowerCase().trim() });
    if (!userMatch) {
      return res.status(404).json({ error: 'User account profile not found.' });
    }
    const alerts = await Alert.find({ sent_to: userMatch.customer_id }).sort({ created_at: -1 });
    return res.status(200).json({ success: true, alerts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/mark-read/:id', async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(req.params.id, { is_read: true }, { new: true });
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found.' });
    }
    return res.status(200).json({ success: true, alert });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = { router, createAlert, checkExpiryAlerts };
