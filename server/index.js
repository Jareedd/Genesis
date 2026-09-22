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

const { getMediaState, canRefresh, registerPartnerDomain, partnerDomain, listVehicles } = require('./tesla');
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

// Hosts like Render have no writable repo to drop a PEM into, so the key can
// also be supplied inline as an env var. Pasting into a dashboard field
// routinely mangles the line breaks — and a PEM whose header and body run
// together is unparseable — so rebuild the canonical form from the base64
// payload rather than trusting the whitespace we were given.
function normalizePem(raw) {
  const text = raw.replace(/\\n/g, '\n');
  const match = text.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!match) return null;

  const label = match[1];
  const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body) return null;

  const wrapped = body.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

function inlinePublicKey() {
  const raw = process.env.TESLA_PUBLIC_KEY_PEM;
  if (!raw || !raw.trim()) return null;
  return normalizePem(raw);
}

function hasPublicKey() {
  return Boolean(inlinePublicKey() || resolvePublicKeyPath());
}

app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (req, res) => {
  const inline = inlinePublicKey();
  if (inline) {
    res.type('application/x-pem-file');
    return res.send(inline);
  }

  const pemPath = resolvePublicKeyPath();
  if (!pemPath) {
    return res
      .status(404)
      .type('text/plain')
      .send(
        'Public key PEM not found. Set TESLA_PUBLIC_KEY_PEM, or copy server/keys/com.tesla.3p.public-key.pem.example to com.tesla.3p.public-key.pem (or set TESLA_PUBLIC_KEY_PATH).'
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
    canRefresh: canRefresh(),
    hasVehicleId: Boolean(process.env.TESLA_VEHICLE_ID),
    publicKey: hasPublicKey(),
    clientBuilt: fs.existsSync(path.resolve(__dirname, '../client/dist/index.html')),
    env: process.env.NODE_ENV || 'development',
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

// --- Vehicle picker: the value TESLA_VEHICLE_ID expects ---
// Renders a table in a browser, returns JSON to anything else.
app.get('/api/vehicles', async (req, res) => {
  let result;
  try {
    result = await listVehicles();
  } catch (err) {
    result = { ok: false, error: 'server_error', message: err.message, vehicles: [] };
  }

  if (!req.accepts('html')) {
    return res.status(result.ok ? 200 : 400).json(result);
  }

  const rows = result.vehicles
    .map(
      (v) => `<tr>
  <td><code class="id">${v.id}</code></td>
  <td>${v.display_name || '<em>unnamed</em>'}</td>
  <td>${v.vin || ''}</td>
  <td>${v.state || ''}</td>
</tr>`
    )
    .join('\n');

  res.type('text/html').send(`<!DOCTYPE html>
<html><head><title>Your vehicles</title>
<style>body{font-family:system-ui;background:#111;color:#eee;padding:2rem;max-width:760px;margin:auto;line-height:1.5}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid #333}
th{color:#9ca3af;font-size:.85rem;text-transform:uppercase}
code{background:#222;padding:.15rem .4rem;border-radius:3px}
.id{color:#4ade80;font-weight:600}
.warn{color:#fbbf24}</style></head>
<body>
<h1>Your vehicles</h1>
${
  result.ok
    ? `<p>Copy the green <strong>id</strong> into <code>TESLA_VEHICLE_ID</code> in Render.</p>
<table><tr><th>id</th><th>name</th><th>vin</th><th>state</th></tr>
${rows || '<tr><td colspan="4"><em>No vehicles on this account.</em></td></tr>'}
</table>
<p class="warn">If state is <code>asleep</code>, wake the car in the Tesla app before expecting media data.</p>`
    : `<p class="warn">${result.message}</p>
<p><a href="/oauth/start" style="color:#60a5fa">Start OAuth</a></p>`
}
</body></html>`);
});

// --- One-time Tesla partner domain registration ---
// Tesla will not serve vehicle data until the app's domain is registered.
// GET renders a confirmation page; the POST behind it does the work, so a
// crawler or prefetch can never trigger the call.
app.get('/api/partner/register', (req, res) => {
  const domain = partnerDomain();
  res.type('text/html').send(`<!DOCTYPE html>
<html><head><title>Register Tesla partner domain</title>
<style>body{font-family:system-ui;background:#111;color:#eee;padding:2rem;max-width:640px;margin:auto;line-height:1.5}
button{background:#e11d48;color:#fff;border:0;padding:.75rem 1.5rem;font-size:1rem;border-radius:6px;cursor:pointer}
code{background:#222;padding:.15rem .4rem;border-radius:3px}
pre{background:#222;padding:1rem;overflow:auto;white-space:pre-wrap;word-break:break-word}
.warn{color:#fbbf24}</style></head>
<body>
<h1>Register partner domain</h1>
${domain
  ? `<p>This registers <code>${domain}</code> with Tesla, using your client id and secret.</p>
     <p class="warn">Before clicking: confirm this URL loads publicly and shows your key —<br>
     <code>https://${domain}/.well-known/appspecific/com.tesla.3p.public-key.pem</code></p>
     <p><button id="go">Register ${domain}</button></p>`
  : `<p class="warn">No domain configured. Set <code>TESLA_PARTNER_DOMAIN</code>, or set
     <code>TESLA_REDIRECT_URI</code> to your public https URL.</p>`}
<pre id="out" hidden></pre>
<script>
const btn = document.getElementById('go');
if (btn) btn.onclick = async () => {
  btn.disabled = true; btn.textContent = 'Registering…';
  const out = document.getElementById('out');
  out.hidden = false; out.textContent = 'Working…';
  try {
    const r = await fetch('/api/partner/register', { method: 'POST' });
    out.textContent = JSON.stringify(await r.json(), null, 2);
  } catch (e) {
    out.textContent = 'Request failed: ' + e.message;
  }
  btn.disabled = false; btn.textContent = 'Try again';
};
</script>
</body></html>`);
});

app.post('/api/partner/register', async (req, res) => {
  try {
    const result = await registerPartnerDomain();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: 'server_error', message: err.message });
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

// Bind 0.0.0.0 so container platforms (Render, Fly, Docker) can route to it.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[tesla-lyrics] server listening on port ${PORT}`);
  console.log(
    `[tesla-lyrics] token=${process.env.TESLA_ACCESS_TOKEN ? 'set' : 'MISSING'} refresh=${canRefresh() ? 'set' : 'MISSING'} vehicle=${process.env.TESLA_VEHICLE_ID || 'MISSING'}`
  );
  if (isProd && !fs.existsSync(clientDist)) {
    console.warn(
      `[tesla-lyrics] WARNING: ${clientDist} is missing — the build step did not run. Only /api routes will respond.`
    );
  }
  if (!isProd) {
    console.log(
      '[tesla-lyrics] Dev tip: run the Vite client (port 5173) which proxies /api → this server.'
    );
  }
});
