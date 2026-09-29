const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");
function jsonRateLimitHandler(message) {
  return (req, res) => {
    res.status(429).json({
      error: message
    });
  };
}
const loginSlowDown = slowDown({
  windowMs: 15 * 60 * 1e3,
  delayAfter: 3,
  delayMs: hits => (hits - 3) * 500,
  maxDelayMs: 8e3
});
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler("Too many requests. Please slow down and try again shortly.")
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler("Too many login attempts. Please try again in a few minutes.")
});
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler("Too many verification code requests. Please try again in a few minutes.")
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler("Too many attempts. Please try again in a few minutes.")
});
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler("Too many invite attempts. Please try again in a few minutes.")
});
const unsignedLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler("Too many requests. Please use the official Kaagazaad app or try again later.")
});
function userKey(req) {
  return req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`;
}
function perUserLimiter({windowMs: windowMs = 15 * 60 * 1e3, max: max, message: message}) {
  return rateLimit({
    windowMs: windowMs,
    max: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userKey,
    handler: jsonRateLimitHandler(message || "Too many requests for this account. Please slow down.")
  });
}
const authenticatedUserLimiter = perUserLimiter({
  max: 600,
  message: "Too many requests for this account. Please slow down."
});
const ocrLimiter = perUserLimiter({
  max: 30,
  message: "Too many scans in a short time. Please wait a few minutes."
});
const aiLimiter = perUserLimiter({
  max: 40,
  message: "Too many AI requests. Please wait a few minutes."
});
const uploadLimiter = perUserLimiter({
  max: 60,
  message: "Too many uploads in a short time. Please wait a few minutes."
});
module.exports = {
  unsignedLimiter: unsignedLimiter,
  perUserLimiter: perUserLimiter,
  authenticatedUserLimiter: authenticatedUserLimiter,
  ocrLimiter: ocrLimiter,
  aiLimiter: aiLimiter,
  uploadLimiter: uploadLimiter,
  globalLimiter: globalLimiter,
  authLimiter: authLimiter,
  otpRequestLimiter: otpRequestLimiter,
  otpVerifyLimiter: otpVerifyLimiter,
  loginSlowDown: loginSlowDown,
  joinLimiter: joinLimiter
};
