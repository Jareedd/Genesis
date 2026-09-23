'use strict';

const crypto = require('crypto');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');

const isProd = process.env.NODE_ENV === 'production';

// Google Fonts are loaded from the CDN in client/index.html, so the style/font
// sources have to allow them. The server also renders a couple of small setup
// pages with inline <script>, hence 'unsafe-inline' on scriptSrc; those pages
// are gated behind auth and disabled by default (see requireSetupEnabled).
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'", 'https://auth.tesla.com'],
  // Rewriting http->https breaks plain-http localhost dev; Render terminates
  // TLS in front of us so it isn't needed there either.
  upgradeInsecureRequests: null,
};

function ownerUsername() {
  const u = process.env.OWNER_USERNAME;
  return u && u.trim() ? u.trim() : null;
}

function ownerPassword() {
  const p = process.env.OWNER_PASSWORD;
  return p && p.length ? p : null;
}

// Owner login is the gate in front of all vehicle data. With no password set
// the server refuses protected routes rather than exposing the car.
function authConfigured() {
  return Boolean(ownerPassword());
}

// Signing keys for the session cookie. Prefer an explicit secret; otherwise
// derive a stable key from the owner password so sessions survive a Render
// restart without a second secret to manage. Falls back to an ephemeral key.
function sessionKeys() {
  const explicit = process.env.SESSION_SECRET;
  if (explicit && explicit.trim()) {
    return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const pw = ownerPassword();
  if (pw) {
    return [crypto.createHash('sha256').update(`teslyr:${pw}`).digest('hex')];
  }
  return [crypto.randomBytes(32).toString('hex')];
}

// Constant-time compare that also tolerates differing lengths.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function applyBaseSecurity(app) {
  // Behind Render's proxy: required so secure cookies are honoured and the
  // rate limiter keys on the real client IP rather than the proxy's.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: true, directives: CSP_DIRECTIVES },
    })
  );

  app.use(
    cookieSession({
      name: 'teslyr.sid',
      keys: sessionKeys(),
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — the cabin browser stays logged in
    })
  );
}

// A few login attempts are normal (fat-fingered on a touchscreen); a flood is
// not. Keyed per IP.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limited', message: 'Too many attempts. Wait a few minutes.' },
});

function handleLogin(req, res) {
  if (!authConfigured()) {
    return res
      .status(503)
      .json({ ok: false, error: 'auth_not_configured', message: 'Owner login is not configured.' });
  }

  const { username, password } = req.body || {};
  const expectedUser = ownerUsername();
  const userOk = expectedUser ? safeEqual(username || '', expectedUser) : true;
  const passOk = password != null && safeEqual(String(password), ownerPassword());

  if (!userOk || !passOk) {
    return res
      .status(401)
      .json({ ok: false, error: 'invalid_credentials', message: 'Incorrect login.' });
  }

  req.session.authed = true;
  req.session.at = Date.now();
  return res.json({ ok: true });
}

function handleLogout(req, res) {
  req.session = null;
  return res.json({ ok: true });
}

function handleSession(req, res) {
  res.json({
    ok: true,
    configured: authConfigured(),
    authenticated: Boolean(req.session && req.session.authed),
    usernameRequired: Boolean(ownerUsername()),
  });
}

function isAuthed(req) {
  return Boolean(req.session && req.session.authed);
}

// Gate for anything that talks to the car or returns vehicle data.
function requireAuth(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'auth_not_configured',
      message: 'Owner login is not configured. Set OWNER_PASSWORD to enable access.',
    });
  }
  if (isAuthed(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Login required.' });
}

// Setup/OAuth routes are off unless explicitly enabled, so a bare deployment
// never exposes token-minting or partner-registration surface.
function setupRoutesEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_SETUP_ROUTES || ''));
}

function requireSetupEnabled(req, res, next) {
  if (!setupRoutesEnabled()) {
    return res.status(404).type('text/plain').send('Not found.');
  }
  return next();
}

module.exports = {
  applyBaseSecurity,
  loginRateLimiter,
  handleLogin,
  handleLogout,
  handleSession,
  requireAuth,
  authConfigured,
  setupRoutesEnabled,
  requireSetupEnabled,
};
