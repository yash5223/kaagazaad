const SecurityEvent = require('../models/SecurityEvent');
function clientIp(req) {
  return req?.ip || req?.headers?.['x-forwarded-for'] || null;
}
function logSecurityEvent(type, { req, userId, email, meta } = {}) {
  const entry = {
    type,
    userId: userId || null,
    email: email || null,
    ip: req ? clientIp(req) : null,
    meta: meta || {},
    at: new Date().toISOString(),
  };
  console.log(`[security] ${JSON.stringify(entry)}`);
  SecurityEvent.create({
    type,
    userId: entry.userId,
    email: entry.email,
    ip: entry.ip,
    meta: entry.meta,
  }).catch((err) => {
    console.error('[security] failed to persist SecurityEvent:', err.message);
  });
}
module.exports = { logSecurityEvent };
