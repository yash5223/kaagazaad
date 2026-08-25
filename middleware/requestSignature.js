const crypto = require('crypto');

// ---------------------------------------------------------------------
// App-level request signing (HMAC) + anti-replay.
//
// This is a SEPARATE layer from authMiddleware.js. A JWT proves "this
// request carries a valid user session"; this middleware proves "this
// request was built by our own client build, right now, and hasn't been
// captured and re-sent" — two different threats:
//
//   - A JWT can be lifted (device compromise, log leakage, a proxy in the
//     middle) and replayed from any HTTP client (curl, Postman, a scraper)
//     indefinitely until it expires. Signing narrows the window: a
//     captured request is only replayable for REPLAY_WINDOW_MS, and only
//     once (the nonce is burned on first use).
//   - It also raises the bar against generic scripted abuse hitting the
//     API surface directly rather than through the real app — a client
//     without the shared secret can't produce a valid signature at all.
//
// IMPORTANT — threat model honesty: the shared secret ships inside the
// mobile/web client build, so a sufficiently motivated attacker who
// decompiles the app (or inspects web bundle/network traffic) CAN recover
// it. This is defense-in-depth, not a substitute for the JWT layer, TLS,
// or server-side authorization checks. Its job is to filter out casual
///scripted abuse and narrow the replay window for captured traffic, not
// to be an unbreakable secret. See SECURITY.md.
// ---------------------------------------------------------------------

// How old a request's timestamp is allowed to be. Wide enough to absorb
// normal clock drift + network latency, narrow enough that a captured
// request can't be replayed hours/days later.
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Nonces are remembered for slightly longer than the replay window so a
// nonce can never be reused even right at the edge of the window. This is
// an in-memory cache — fine for a single-instance deploy; if this app
// ever runs multiple instances behind a load balancer, swap this for a
// shared store (Redis) so replay protection holds across instances.
const NONCE_TTL_MS = REPLAY_WINDOW_MS + 60 * 1000;
const seenNonces = new Map(); // nonce -> expiry timestamp (ms)

let cleanupTimer = null;
function startNonceCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [nonce, expiresAt] of seenNonces) {
      if (expiresAt <= now) seenNonces.delete(nonce);
    }
  }, 60 * 1000);
  cleanupTimer.unref?.();
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Recomputes the expected signature for a request. The signed string
 * binds method + path + timestamp + nonce + raw body together, so
 * changing ANY of those (route, payload, replay time) invalidates the
 * signature — not just a static shared-secret header a proxy could copy
 * verbatim onto a different request.
 */
function computeSignature(secret, { method, path, timestamp, nonce, rawBody }) {
  const payload = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${rawBody || ''}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Express middleware factory. Apply to routes/routers that should require
 * a valid app signature. `required: false` runs it in observe-only mode
 * (logs mismatches but never blocks) — useful while rolling this out
 * against an already-shipped client that doesn't sign requests yet.
 */
function requestSignature({ required = true } = {}) {
  startNonceCleanup();
  const secret = process.env.APP_SIGNING_SECRET;

  return function (req, res, next) {
    if (!secret) {
      // Not configured: this deployment hasn't opted into this layer.
      // Fail open in dev, but make the gap loud so it isn't silently
      // relied on in an environment where it was actually meant to run.
      if (process.env.NODE_ENV === 'production' && required) {
        console.error('[requestSignature] APP_SIGNING_SECRET is not set — request signing is disabled in production.');
      }
      return next();
    }

    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const signature = req.headers['x-signature'];

    const reject = (status, message) => {
      if (!required) return next(); // observe-only mode
      return res.status(status).json({ error: message });
    };

    if (!timestamp || !nonce || !signature) {
      return reject(401, 'Missing request signature headers.');
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      return reject(401, 'Request timestamp is missing, malformed, or outside the allowed window.');
    }

    if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
      return reject(401, 'Invalid request nonce.');
    }

    const existing = seenNonces.get(nonce);
    if (existing && existing > Date.now()) {
      return reject(401, 'This request has already been used.');
    }

    const rawBody = req.rawBody || ''; // populated by server.js body-parser verify hook
    const expected = computeSignature(secret, {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      timestamp,
      nonce,
      rawBody,
    });

    if (!timingSafeEqualStr(expected, String(signature))) {
      return reject(401, 'Invalid request signature.');
    }

    // Burn the nonce only once we know the signature is valid, so a flood
    // of garbage nonces can't be used to exhaust memory cheaply (an
    // attacker still pays the HMAC-compute cost either way, but we don't
    // grow the map for signatures that were never going to pass).
    seenNonces.set(nonce, Date.now() + NONCE_TTL_MS);

    return next();
  };
}

module.exports = { requestSignature, computeSignature, REPLAY_WINDOW_MS };
