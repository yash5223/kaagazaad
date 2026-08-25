const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
function jsonRateLimitHandler(message) {
  return (req, res ) => {
    res.status(429).json({ error: message });
  };
}
const loginSlowDown = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 3, 
  delayMs: (hits) => (hits - 3) * 500, 
  maxDelayMs: 8000, 
});
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many requests. Please slow down and try again shortly.'),
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many login attempts. Please try again in a few minutes.'),
});
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many verification code requests. Please try again in a few minutes.'),
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many attempts. Please try again in a few minutes.'),
});
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many invite attempts. Please try again in a few minutes.'),
});
module.exports = { globalLimiter, authLimiter, otpRequestLimiter, otpVerifyLimiter, loginSlowDown, joinLimiter };
