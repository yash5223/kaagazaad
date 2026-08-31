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
const { joinLimiter } = require('./middleware/rateLimiters');
const { logSecurityEvent } = require('./utils/securityLog');
const app = express();
if (process.env.NODE_ENV === 'production' && !process.env.APP_SIGNING_SECRET) {
  console.error('[startup] APP_SIGNING_SECRET is not set — refusing to start in production without app request signing.');
  process.exit(1);
}
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
app.set('trust proxy', 1);
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
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});
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
function captureRawBody(req, _res, buf) {
  req.rawBody = buf.toString('utf8');
}
app.use(express.json({ limit: '1mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '1mb', verify: captureRawBody }));
app.use(mongoSanitize());
app.use(hpp());
app.use(globalLimiter);
app.use('/api', requestSignature({ required: false }));
app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.originalUrl.split('?')[0]}`);
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
    try {
      const SharedDocument = require('./models/SharedDocument');
      await SharedDocument.syncIndexes();
      console.log('SharedDocument indexes synced.');
    } catch (indexErr) {
      console.error('Failed to sync SharedDocument indexes:', indexErr);
    }
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
app.get('/healthz', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const ok = dbState === 1;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    db: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
  });
});
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/\//g, '\\/');
}
app.get('/join/:token', joinLimiter, async (req, res) => {
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
    <p>${escapeHtml(statusMessage)}</p>
    ${statusOk ? `
      <div class="token" id="tokenBox">${escapeHtml(token)}</div>
      <button onclick="window.location.href=${safeJsonForScript(deepLink)}">Open in Kaagazaad app</button>
      <button class="secondary" onclick="copyToken()">Copy invite code</button>
      <p style="font-size:13px; margin-top:16px;">
        If the app doesn't open automatically, open Kaagazaad and enter this code
        on the "Join Vault" screen.
      </p>
    ` : ''}
  </div>
  <script nonce="${res.locals.cspNonce}">
    function copyToken() {
      navigator.clipboard.writeText(${safeJsonForScript(token)});
      alert('Invite code copied');
    }
    ${statusOk ? `window.location.href = ${safeJsonForScript(deepLink)};` : ''}
  </script>
</body>
</html>`);
});
// 404 for anything that didn't match a route above.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});
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
