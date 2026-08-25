const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

// Shared JSON error handler so a rate-limit hit looks like every other API
// error response instead of express-rate-limit's default plain text.
function jsonRateLimitHandler(message) {
  return (req, res /*, next, options */) => {
    res.status(429).json({ error: message });
  };
}

// Progressive throttle layered IN FRONT of the hard limiters below on the
// most sensitive endpoints (login, OTP). Hard limits (authLimiter etc.)
// are a wall: once you hit them, every request 429s until the window
// resets. This is a ramp: each successive request in the window gets
// slower than the last, so a scripted brute-force loop bleeds time long
// before it ever reaches the hard wall, while a real user who mistypes a
// password once or twice barely notices. Two different shapes of
// friction, stacked, rather than one limiter doing both jobs.
const loginSlowDown = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 3, // first 3 requests in the window are at full speed
  delayMs: (hits) => (hits - 3) * 500, // then +500ms per request, growing
  maxDelayMs: 8000, // never delay a single request more than 8s
});

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

module.exports = { globalLimiter, authLimiter, otpRequestLimiter, otpVerifyLimiter, loginSlowDown };
