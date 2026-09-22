'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');

// Load .env from project root, then server/.env as fallback
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { getMediaState } = require('./tesla');
const { fetchLyrics } = require('./lyrics');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const isProd = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json());

// --- Tesla partner public key (required for Fleet API third-party apps) ---
const publicKeyCandidates = [
  process.env.TESLA_PUBLIC_KEY_PATH,
  path.join(__dirname, 'keys', 'com.tesla.3p.public-key.pem'),
  path.join(__dirname, 'keys', 'com.tesla.3p.public-key.pem.example'),
].filter(Boolean);

function resolvePublicKeyPath() {
  for (const p of publicKeyCandidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (req, res) => {
  const pemPath = resolvePublicKeyPath();
  if (!pemPath) {
    return res
      .status(404)
      .type('text/plain')
      .send(
        'Public key PEM not found. Copy server/keys/com.tesla.3p.public-key.pem.example to com.tesla.3p.public-key.pem (or set TESLA_PUBLIC_KEY_PATH).'
      );
  }
  res.type('application/x-pem-file');
  fs.createReadStream(pemPath).pipe(res);
});

// --- Media + lyrics APIs ---
app.get('/api/media_state', async (req, res) => {
  try {
    const state = await getMediaState();
    res.json(state);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'server_error',
      message: err.message,
      media: null,
    });
  }
});

app.get('/api/lyrics', async (req, res) => {
  try {
    const { title, artist, duration } = req.query;
    const result = await fetchLyrics({
      title: title ? String(title) : '',
      artist: artist ? String(artist) : '',
      duration: duration != null && duration !== '' ? Number(duration) : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'server_error',
      message: err.message,
      lines: [],
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasToken: Boolean(process.env.TESLA_ACCESS_TOKEN),
    hasVehicleId: Boolean(process.env.TESLA_VEHICLE_ID),
    publicKey: Boolean(resolvePublicKeyPath()),
  });
});

// --- Optional OAuth scaffolding ---
const AUTH_BASE = 'https://auth.tesla.com/oauth2/v3';

app.get('/oauth/start', (req, res) => {
  const clientId = process.env.TESLA_CLIENT_ID;
  const redirectUri = process.env.TESLA_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res
      .status(400)
      .type('text/plain')
      .send(
        'Set TESLA_CLIENT_ID and TESLA_REDIRECT_URI in .env before starting OAuth.'
      );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid offline_access vehicle_device_data vehicle_cmds',
    state: 'tesla-lyrics-' + Date.now(),
  });

  res.redirect(`${AUTH_BASE}/authorize?${params.toString()}`);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error, error_description: errorDesc } = req.query;
  if (error) {
    return res
      .status(400)
      .type('text/html')
      .send(
        `<h1>OAuth error</h1><pre>${error}: ${errorDesc || ''}</pre>`
      );
  }
  if (!code) {
    return res.status(400).type('text/plain').send('Missing authorization code.');
  }

  const clientId = process.env.TESLA_CLIENT_ID;
  const clientSecret = process.env.TESLA_CLIENT_SECRET;
  const redirectUri = process.env.TESLA_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res
      .status(500)
      .type('text/plain')
      .send('Missing TESLA_CLIENT_ID / TESLA_CLIENT_SECRET / TESLA_REDIRECT_URI.');
  }

  try {
    const tokenRes = await axios.post(
      `${AUTH_BASE}/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        redirect_uri: redirectUri,
        audience: process.env.TESLA_FLEET_BASE_URL ||
          'https://fleet-api.prd.na.vn.cloud.tesla.com',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    // Do not persist tokens to disk automatically (security). Show once for copy/paste.
    res.type('text/html').send(`<!DOCTYPE html>
<html><head><title>Tesla OAuth</title>
<style>body{font-family:system-ui;background:#111;color:#eee;padding:2rem;max-width:720px;margin:auto}
code,pre{background:#222;padding:.5rem;display:block;overflow:auto;word-break:break-all}
.note{color:#fbbf24}</style></head>
<body>
<h1>Authorization successful</h1>
<p class="note">Copy the access token into your <code>.env</code> as <code>TESLA_ACCESS_TOKEN</code>. Do not commit it.</p>
<p><strong>expires_in:</strong> ${expires_in || 'n/a'} seconds</p>
<h2>access_token</h2>
<pre>${access_token || ''}</pre>
<h2>refresh_token</h2>
<pre>${refresh_token || '(none)'}</pre>
<p><a href="/api/health">Check /api/health</a></p>
</body></html>`);
  } catch (err) {
    const detail =
      (err.response && err.response.data && JSON.stringify(err.response.data, null, 2)) ||
      err.message;
    res
      .status(502)
      .type('text/html')
      .send(`<h1>Token exchange failed</h1><pre>${detail}</pre>`);
  }
});

// Production: serve Vite build
const clientDist = path.resolve(__dirname, '../client/dist');
if (isProd && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/oauth') || req.path.startsWith('/.well-known')) {
      return next();
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[tesla-lyrics] server listening on http://localhost:${PORT}`);
  console.log(
    `[tesla-lyrics] token=${process.env.TESLA_ACCESS_TOKEN ? 'set' : 'MISSING'} vehicle=${process.env.TESLA_VEHICLE_ID || 'MISSING'}`
  );
  if (!isProd) {
    console.log(
      '[tesla-lyrics] Dev tip: run the Vite client (port 5173) which proxies /api → this server.'
    );
  }
});
