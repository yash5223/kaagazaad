const SecurityEvent = require('../models/SecurityEvent');

// Best-effort request IP extraction. `app.set('trust proxy', ...)` in
// server.js controls whether Express trusts X-Forwarded-For (needed
// behind Render/any reverse proxy) — req.ip already reflects that setting.
function clientIp(req) {
  return req?.ip || req?.headers?.['x-forwarded-for'] || null;
}

/**
 * Records a security-relevant event both to stdout (structured, so it's
 * greppable/shippable to whatever log aggregator is watching the process —
 * see monitoring notes in SECURITY.md) and to the SecurityEvent collection
 * (queryable audit trail). Logging is fire-and-forget and never allowed to
 * throw into the caller — a logging failure should never break the auth
 * flow it's describing.
 *
 * @param {string} type - short event name, e.g. 'login_success', 'login_failure',
 *   'login_lockout', 'pin_failure', 'pin_lockout', 'password_reset', 'register',
 *   'document_deleted'
 * @param {object} [details]
 * @param {import('express').Request} [details.req] - used to pull IP; not stored directly
 * @param {string} [details.userId] - customer_id, if known
 * @param {string} [details.email]
 * @param {object} [details.meta] - any extra structured detail (never secrets)
 */
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
