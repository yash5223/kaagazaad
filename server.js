require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const userRoutes = require('./routes/userRoutes');
const scanReceiptRoutes = require('./routes/scanReceipt');
const assetRoutes = require('./routes/assetRoutes');
const vaultRoutes = require('./routes/vaultRoutes');
const aiRoutes = require('./routes/aiRoutes');
const { router: alertRoutes } = require('./routes/alertRoutes');
const Invite = require('./models/Invite');
const { globalLimiter } = require('./middleware/rateLimiters');
const { errorHandler } = require('./middleware/errorHandler');
const { requestSignature } = require('./middleware/requestSignature');
const app = express();

// Optional error/uptime monitoring: if SENTRY_DSN is set, initialize
// Sentry as early as possible so it can capture request context. When
// unset (e.g. local dev), this is a complete no-op — nothing else in the
// app depends on it being configured. See SECURITY.md for setup notes.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });
  console.log('[monitoring] Sentry error reporting enabled');
} else {
  console.warn('[monitoring] SENTRY_DSN not set — error reporting to Sentry is disabled. See SECURITY.md.');
}

// Render (and most PaaS hosts) put the app behind a reverse proxy, so the
// real client IP arrives via X-Forwarded-For rather than the raw socket
// address. `trust proxy` tells Express (and therefore express-rate-limit
// and req.ip, used by utils/securityLog.js) to read that header instead of
// logging/rate-limiting every request as if it came from the proxy itself.
app.set('trust proxy', 1);

// Sets a battery of security-related HTTP headers (X-Content-Type-Options,
// X-Frame-Options, HSTS, etc). A real Content-Security-Policy is enabled
// (rather than disabled) because this app DOES render one HTML page —
// /join/:token — and a locked-down CSP costs nothing on the pure-JSON API
// routes while meaningfully limiting what an injected/compromised script
// could do on that page (no external scripts, no inline scripts except
// the one we explicitly nonce below, no framing). See the /join route for
// how the nonce is generated and applied.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'"], // /join uses a small inline <style> block, no external stylesheets
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // uploaded documents are legitimately fetched by the Flutter client from a different origin
}));

// CORS is restricted to an explicit allowlist read from ALLOWED_ORIGINS
// (comma-separated) rather than left wide open. Requests with no Origin
// header (native mobile apps, curl, server-to-server calls) are allowed
// through, since they're not subject to the same-origin policy CORS
// protects against in the first place — mobile HTTP clients don't send an
// Origin header the way browsers do.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn(
    '[cors] ALLOWED_ORIGINS is not set — no browser origins are allowlisted. ' +
    'Set ALLOWED_ORIGINS (comma-separated) in your environment for any web clients that need access.'
  );
}
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // native app / server-to-server, no Origin header
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Body size caps: this API deals in small JSON payloads (form fields,
// tokens, ids) — file uploads go through multer on their own routes with
// their own limits (see routes/assetRoutes.js, routes/scanReceipt.js), not
// through this JSON body parser. Capping it here stops a client from
// sending a huge JSON body to routes that were never meant to receive one.
// The `verify` hook stashes the exact raw bytes received on req.rawBody —
// needed by middleware/requestSignature.js, since a signature computed
// over the RE-SERIALIZED (parsed-then-stringified) body would not match
// one the client computed over the bytes it actually sent.
function captureRawBody(req, _res, buf) {
  req.rawBody = buf.toString('utf8');
}
app.use(express.json({ limit: '1mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '1mb', verify: captureRawBody }));

// Defense-in-depth against NoSQL injection: strips any request key that
// starts with `$` or contains `.` from body/query/params before it ever
// reaches a route handler or Mongoose query. middleware/validators.js
// (zod) is the primary defense — it defines exactly what shape each field
// may take — but this is a cheap blanket backstop for any field a route
// or future change forgets to run through validate().
app.use(mongoSanitize());

// HTTP Parameter Pollution guard: if a client sends the same query-string
// key twice (?role=view&role=admin), Express normally hands the route an
// array; a route written assuming a single string can behave unexpectedly
// on the duplicated value. This collapses duplicates down to the last
// value before routes ever see them.
app.use(hpp());

// Global rate limit applied to every request. Individual auth/OTP routes
// layer tighter limits on top of this (see routes/userRoutes.js).
app.use(globalLimiter);

// App-level request signing (HMAC + anti-replay) — see
// middleware/requestSignature.js for the full rationale. This sits BEFORE
// authMiddleware in the stack (which is applied per-route), so a forged
// request is rejected before it ever gets to spend a JWT-verification
// cycle. It automatically no-ops (fails open) whenever APP_SIGNING_SECRET
// isn't set in the environment, so it's safe to deploy ahead of an
// updated, signing-capable client build — set the env var once every
// client in the field has been updated to sign its requests.
app.use('/api', requestSignature({ required: true }));

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});
app.use('/api/users', userRoutes);
app.use('/api/receipt', scanReceiptRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/ai', aiRoutes); 
app.use('/api/alerts', alertRoutes);
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('[startup] MONGODB_URI is not set — refusing to start without a database connection string.');
  process.exit(1);
}
if (!/^mongodb(\+srv)?:\/\//.test(MONGODB_URI)) {
  console.error('[startup] MONGODB_URI does not look like a valid MongoDB connection string.');
  process.exit(1);
}
// A `mongodb+srv://` URI (Atlas's standard format) implies TLS is on by
// default; a plain `mongodb://` URI does not. Warn loudly rather than
// silently connecting without encryption in transit if someone points this
// at a non-Atlas / manually-configured cluster.
if (MONGODB_URI.startsWith('mongodb://') && !/[?&]tls=true/.test(MONGODB_URI)) {
  console.warn(
    '[startup] MONGODB_URI uses the plain mongodb:// scheme without an explicit tls=true option. ' +
    'Atlas connection strings (mongodb+srv://) are TLS by default; if this is not Atlas, confirm the ' +
    'connection is encrypted in transit. See SECURITY.md.'
  );
}
mongoose.set('bufferTimeoutMS', 8000);
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 8000, 
})
  .then(async () => {
    console.log('Connected to MongoDB Atlas');
    // Keep every model's indexes in sync with its schema. This matters a lot
    // for SharedDocument: an older deploy created a FULLY unique index on
    // (ownerCustomerId, receiverEmail, assetId), which silently blocked a
    // document from ever being shared to the same person a second time
    // (even after being revoked). The current schema only wants that
    // uniqueness enforced among ACTIVE shares (a partial index), so on boot
    // we drop the stale index and rebuild the correct one automatically.
    try {
      const SharedDocument = require('./models/SharedDocument');
      await SharedDocument.syncIndexes();
      console.log('SharedDocument indexes synced.');
    } catch (indexErr) {
      console.error('Failed to sync SharedDocument indexes:', indexErr);
    }
    // Same story for User: aadhaarHash replaces the old unique index on the
    // plaintext `aadhaar` field now that Aadhaar numbers are stored
    // encrypted. Sync so the stale index doesn't linger in existing
    // deployments.
    try {
      const User = require('./models/User');
      await User.syncIndexes();
      console.log('User indexes synced.');
    } catch (indexErr) {
      console.error('Failed to sync User indexes:', indexErr);
    }
  })
  .catch((err) => console.error('Connection error:', err));
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Uptime-monitor target (UptimeRobot, Better Stack, Render health checks,
// etc.) — reports whether the process is up AND whether it can actually
// reach MongoDB, since a process that's alive but DB-disconnected still
// can't serve real traffic.
app.get('/healthz', (req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  const ok = dbState === 1;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    db: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
  });
});
app.get('/join/:token', async (req, res) => {
  const { token } = req.params;
  let statusMessage = 'This invite link is invalid.';
  let statusOk = false;
  try {
    const invite = await Invite.findOne({ token });
    if (invite) {
      if (invite.status === 'accepted') {
        statusMessage = 'This invite has already been used.';
      } else if (invite.status === 'revoked' || invite.expiresAt < new Date()) {
        statusMessage = 'This invite link has expired or was revoked.';
      } else {
        statusOk = true;
        statusMessage = `You've been invited to join a Kaagazaad family vault as ${invite.role}.`;
      }
    }
  } catch (err) {
    statusMessage = 'Something went wrong checking this invite.';
  }
  const deepLink = `kaagazaad://join/${token}`;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Join Kaagazaad Vault</title>
<style>
  body { font-family: -apple-system, Roboto, Arial, sans-serif; background:#FAFAFB; color:#0B1F3D;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .card { max-width:420px; width:100%; background:#fff; border-radius:16px; padding:32px 24px;
          box-shadow:0 4px 24px rgba(0,0,0,0.08); text-align:center; }
  h1 { font-size:22px; margin-bottom:12px; }
  p { font-size:15px; color:#4A5568; line-height:1.5; }
  .token { font-family:monospace; background:#F1F3F6; border-radius:8px; padding:10px 14px;
           margin:16px 0; font-size:14px; word-break:break-all; }
  button { background:#0B1F3D; color:#fff; border:none; border-radius:10px; padding:12px 20px;
           font-size:15px; cursor:pointer; width:100%; margin-top:8px; }
  button.secondary { background:#fff; color:#0B1F3D; border:1px solid #D8DCE3; }
</style>
</head>
<body>
  <div class="card">
    <h1>Kaagazaad</h1>
    <p>${statusMessage}</p>
    ${statusOk ? `
      <div class="token" id="tokenBox">${token}</div>
      <button onclick="window.location.href='${deepLink}'">Open in Kaagazaad app</button>
      <button class="secondary" onclick="copyToken()">Copy invite code</button>
      <p style="font-size:13px; margin-top:16px;">
        If the app doesn't open automatically, open Kaagazaad and enter this code
        on the "Join Vault" screen.
      </p>
    ` : ''}
  </div>
  <script nonce="${res.locals.cspNonce}">
    function copyToken() {
      navigator.clipboard.writeText(${JSON.stringify(token)});
      alert('Invite code copied');
    }
    ${statusOk ? `window.location.href = ${JSON.stringify(deepLink)};` : ''}
  </script>
</body>
</html>`);
});
// 404 for anything that didn't match a route above.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Central error handler — must be registered last. Catches anything routes
// pass to next(err) or that an asyncHandler-wrapped route throws, and is
// the single place allowed to decide what error detail (if any) reaches
// the client. See middleware/errorHandler.js.
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  const PING_INTERVAL_MS = 10 * 60 * 1000;
  setInterval(() => {
    fetch(selfUrl)
      .then(() => console.log('[keep-alive] self-ping OK'))
      .catch((err) => console.error('[keep-alive] self-ping failed:', err.message));
  }, PING_INTERVAL_MS);
  console.log(`[keep-alive] self-ping enabled, pinging ${selfUrl} every ${PING_INTERVAL_MS / 60000} min`);
}
