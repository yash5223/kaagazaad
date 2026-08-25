const rateLimit = require('express-rate-limit');

// Shared JSON error handler so a rate-limit hit looks like every other API
// error response instead of express-rate-limit's default plain text.
function jsonRateLimitHandler(message) {
  return (req, res /*, next, options */) => {
    res.status(429).json({ error: message });
  };
}

// Global baseline: generous enough for normal app usage, tight enough to
// blunt scripted abuse hitting the API as a whole.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many requests. Please slow down and try again shortly.'),
});

// Login/auth-adjacent endpoints: much tighter, since these are the classic
// credential-stuffing / brute-force targets.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many login attempts. Please try again in a few minutes.'),
});

// Requesting an OTP (registration or password reset): limited per IP to
// stop someone from spamming an inbox or burning through email-sending
// quota.
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many verification code requests. Please try again in a few minutes.'),
});

// Verifying an OTP: separate, slightly higher limit than the request
// limiter (a user might legitimately mistype a code a couple of times),
// but still tight. This is on top of the per-code attempt counter in
// userRoutes.js — this one limits requests per IP across all codes, that
// one limits guesses against one specific code.
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler('Too many attempts. Please try again in a few minutes.'),
});

module.exports = { globalLimiter, authLimiter, otpRequestLimiter, otpVerifyLimiter };
