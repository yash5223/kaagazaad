const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: {
      type: String,
      enum: ['info', 'warning', 'success', 'error', 'reminder', 'announcement'],
      default: 'info',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    sent_by: { type: String, default: 'System' },
    sent_to: { type: String, required: true, index: true },
    related_asset_id: { type: String, default: null, index: true },
    is_read: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now },
    created_time: { type: String, default: () => new Date().toLocaleTimeString() },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Alert', alertSchema);
