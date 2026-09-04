const crypto = require("crypto");
const {logSecurityEvent: logSecurityEvent} = require("../utils/securityLog");
const REPLAY_WINDOW_MS = 5 * 60 * 1e3;
const NONCE_TTL_MS = REPLAY_WINDOW_MS + 60 * 1e3;
const seenNonces = new Map;
let cleanupTimer = null;
function startNonceCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [nonce, expiresAt] of seenNonces) {
      if (expiresAt <= now) seenNonces.delete(nonce);
    }
  }, 60 * 1e3);
  cleanupTimer.unref?.();
}
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function computeSignature(secret, {method: method, path: path, timestamp: timestamp, nonce: nonce, rawBody: rawBody}) {
  const payload = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${rawBody || ""}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
function requestSignature({required: required = true} = {}) {
  startNonceCleanup();
  const secret = process.env.APP_SIGNING_SECRET;
  return function(req, res, next) {
    if (!secret) {
      if (process.env.NODE_ENV === "production" && required) {
        console.error("[requestSignature] APP_SIGNING_SECRET is not set — request signing is disabled in production.");
      }
      return next();
    }
    const timestamp = req.headers["x-timestamp"];
    const nonce = req.headers["x-nonce"];
    const signature = req.headers["x-signature"];
    const reject = (status, message) => {
      logSecurityEvent("request_signature_rejected", {
        req: req,
        meta: {
          reason: message,
          path: req.originalUrl.split("?")[0],
          method: req.method
        }
      });
      if (!required) return next();
      return res.status(status).json({
        error: message
      });
    };
    if (!timestamp || !nonce || !signature) {
      return reject(401, "Missing request signature headers.");
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      return reject(401, "Request timestamp is missing, malformed, or outside the allowed window.");
    }
    if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) {
      return reject(401, "Invalid request nonce.");
    }
    const existing = seenNonces.get(nonce);
    if (existing && existing > Date.now()) {
      return reject(401, "This request has already been used.");
    }
    const rawBody = req.rawBody || "";
    const expected = computeSignature(secret, {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      timestamp: timestamp,
      nonce: nonce,
      rawBody: rawBody
    });
    if (!timingSafeEqualStr(expected, String(signature))) {
      return reject(401, "Invalid request signature.");
    }
    seenNonces.set(nonce, Date.now() + NONCE_TTL_MS);
    return next();
  };
}
module.exports = {
  requestSignature: requestSignature,
  computeSignature: computeSignature,
  REPLAY_WINDOW_MS: REPLAY_WINDOW_MS
};