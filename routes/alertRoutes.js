const express = require("express");
const {reportError: reportError} = require("../utils/monitoring");
const router = express.Router();
const Alert = require("../models/Alert");
const authMiddleware = require("../middleware/authMiddleware");
const {limitFor: limitFor} = require("../utils/planLimits");
async function createAlert({title: title, message: message, type: type = "info", priority: priority = "medium", sent_by: sent_by = "System", sent_to: sent_to, related_asset_id: related_asset_id = null}) {
  try {
    if (!sent_to) return null;
    const alert = new Alert({
      title: title,
      message: message,
      type: type,
      priority: priority,
      sent_by: sent_by,
      sent_to: sent_to,
      related_asset_id: related_asset_id
    });
    await alert.save();
    return alert;
  } catch (err) {
    console.error("createAlert error:", err.message);
    return null;
  }
}
async function checkExpiryAlerts(userMatch, assets) {
  try {
    const now = new Date;
    const cap = limitFor(userMatch.subscription_plan, "warranties");
    let tracked = null;
    if (typeof cap === "number") {
      tracked = new Set(assets.filter(a => a.expiryDate && new Date(a.expiryDate) > now).sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate)).slice(0, cap).map(a => a._id.toString()));
    }
    const existingKeys = new Set;
    const withExpiry = assets.filter(a => a.expiryDate);
    if (withExpiry.length > 0) {
      const prior = await Alert.find({ sent_to: userMatch.customer_id });
      prior.forEach(a => {
        if (a.related_asset_id) existingKeys.add(`${a.related_asset_id}|${a.title}`);
      });
    }
    for (const asset of assets) {
      if (!asset.expiryDate) continue;
      if (tracked && !tracked.has(asset._id.toString())) continue;
      const expiry = new Date(asset.expiryDate);
      if (isNaN(expiry.getTime())) continue;
      const diffDays = Math.floor((expiry - now) / (1e3 * 60 * 60 * 24));
      let title = null;
      let type = "reminder";
      let priority = "medium";
      if (diffDays < 0) {
        title = "Document Expired";
        type = "error";
        priority = "high";
      } else if (diffDays <= 30) {
        title = "Document Expiring Soon";
        type = "reminder";
        priority = diffDays <= 7 ? "high" : "medium";
      } else {
        continue;
      }
      const dedupeKey = `${asset._id.toString()}|${title}`;
      if (existingKeys.has(dedupeKey)) continue;
      existingKeys.add(dedupeKey);
      const message = diffDays < 0 ? `"${asset.name}" expired ${Math.abs(diffDays)} day(s) ago.` : `"${asset.name}" expires in ${diffDays} day(s).`;
      await createAlert({
        title: title,
        message: message,
        type: type,
        priority: priority,
        sent_by: "System",
        sent_to: userMatch.customer_id,
        related_asset_id: asset._id.toString()
      });
    }
  } catch (err) {
    console.error("checkExpiryAlerts error:", err.message);
  }
}
router.get("/fetch-alerts", authMiddleware, async (req, res) => {
  try {
    const alerts = await Alert.find({
      sent_to: req.user.customer_id
    }).sort({
      created_at: -1
    });
    return res.status(200).json({
      success: true,
      alerts: alerts
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.patch("/mark-read/:id", authMiddleware, async (req, res) => {
  try {
    const alert = await Alert.findOneAndUpdate({
      _id: req.params.id,
      sent_to: req.user.customer_id
    }, {
      is_read: true
    }, {
      new: true
    });
    if (!alert) {
      return res.status(404).json({
        error: "Alert not found."
      });
    }
    return res.status(200).json({
      success: true,
      alert: alert
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
module.exports = {
  router: router,
  createAlert: createAlert,
  checkExpiryAlerts: checkExpiryAlerts
};
