const SecurityEvent = require("../models/SecurityEvent");
const {recordSecurityEvent: recordSecurityEvent} = require("./securityAlerts");
function clientIp(req) {
  return req?.ip || req?.headers?.["x-forwarded-for"] || null;
}
function logSecurityEvent(type, {req: req, userId: userId, email: email, meta: meta} = {}) {
  const entry = {
    type: type,
    userId: userId || null,
    email: email || null,
    ip: req ? clientIp(req) : null,
    meta: meta || {},
    at: (new Date).toISOString()
  };
  console.log(`[security] ${JSON.stringify(entry)}`);
  try {
    recordSecurityEvent(type);
  } catch (_) {}
  SecurityEvent.create({
    type: type,
    userId: entry.userId,
    email: entry.email,
    ip: entry.ip,
    meta: entry.meta
  }).catch(err => {
    console.error("[security] failed to persist SecurityEvent:", err.message);
  });
}
module.exports = {
  logSecurityEvent: logSecurityEvent
};
