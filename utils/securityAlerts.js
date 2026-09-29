const {captureSecurityMessage} = require("./monitoring");
const MIN = 60 * 1e3;
const RULES = {
  login_lockout: {threshold: 5, windowMs: 10 * MIN, level: "warning"},
  pin_lockout: {threshold: 5, windowMs: 10 * MIN, level: "warning"},
  request_signature_rejected: {threshold: 50, windowMs: 10 * MIN, level: "warning"},
  device_verify_failure: {threshold: 10, windowMs: 10 * MIN, level: "warning"},
  upload_blocked: {threshold: 3, windowMs: 30 * MIN, level: "error"},
  refresh_token_reuse: {threshold: 1, windowMs: 10 * MIN, level: "error"}
};
const hits = new Map();
async function postWebhook(text) {
  const url = process.env.SECURITY_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({text: text, content: text})
    });
  } catch (err) {
    console.error("[security-alert] webhook failed:", err.message);
  }
}
function recordSecurityEvent(type) {
  const rule = RULES[type];
  if (!rule) return false;
  const now = Date.now();
  const list = (hits.get(type) || []).filter(t => now - t < rule.windowMs);
  list.push(now);
  if (list.length >= rule.threshold) {
    hits.set(type, []);
    const message = `Security alert: ${list.length}x ${type} in ${Math.round(rule.windowMs / MIN)} min`;
    console.warn(`[security-alert] ${message}`);
    captureSecurityMessage(message, {level: rule.level, tags: {security_alert: type}});
    postWebhook(`Kaagazaad - ${message}`);
    return true;
  }
  hits.set(type, list);
  return false;
}
module.exports = {recordSecurityEvent: recordSecurityEvent, RULES: RULES};
