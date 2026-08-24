require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const userRoutes = require('./routes/userRoutes');
const scanReceiptRoutes = require('./routes/scanReceipt');
const assetRoutes = require('./routes/assetRoutes');
const vaultRoutes = require('./routes/vaultRoutes');
const aiRoutes = require('./routes/aiRoutes');
const { router: alertRoutes } = require('./routes/alertRoutes');
const Invite = require('./models/Invite');
const app = express();
app.use(cors());
app.use(express.json());
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
  })
  .catch((err) => console.error('Connection error:', err));
app.get('/', (req, res) => {
  res.send('Server is running');
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
  <script>
    function copyToken() {
      navigator.clipboard.writeText(${JSON.stringify(token)});
      alert('Invite code copied');
    }
    ${statusOk ? `window.location.href = ${JSON.stringify(deepLink)};` : ''}
  </script>
</body>
</html>`);
});
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