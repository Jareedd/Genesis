'use strict';

const axios = require('axios');

const FLEET_BASE =
  process.env.TESLA_FLEET_BASE_URL ||
  'https://fleet-api.prd.na.vn.cloud.tesla.com';

const AUTH_TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token';

// Tesla access tokens expire after ~8 hours. A long-running deployment must
// refresh them itself, so the token lives in memory and is re-minted from
// TESLA_REFRESH_TOKEN on demand.
let tokenCache = { accessToken: null, expiresAt: 0 };

function canRefresh() {
  return Boolean(process.env.TESLA_REFRESH_TOKEN && process.env.TESLA_CLIENT_ID);
}

async function refreshAccessToken() {
  if (!canRefresh()) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.TESLA_CLIENT_ID,
    refresh_token: process.env.TESLA_REFRESH_TOKEN,
  });
  if (process.env.TESLA_CLIENT_SECRET) {
    body.set('client_secret', process.env.TESLA_CLIENT_SECRET);
  }

  const res = await axios.post(AUTH_TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (res.status >= 400 || !res.data || !res.data.access_token) {
    const detail =
      (res.data && (res.data.error_description || res.data.error)) || res.statusText;
    console.error(`[tesla-lyrics] token refresh failed (${res.status}): ${detail}`);
    return null;
  }

  const ttlMs = (Number(res.data.expires_in) || 8 * 3600) * 1000;
  // Renew a minute early so an in-flight request never races the expiry.
  tokenCache = { accessToken: res.data.access_token, expiresAt: Date.now() + ttlMs - 60000 };
  console.log('[tesla-lyrics] access token refreshed');
  return tokenCache.accessToken;
}

/**
 * Current bearer token: cached refresh result, else the static env token.
 * forceRefresh re-mints even if a cached/static token exists (used after a 401).
 */
async function getAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
      return tokenCache.accessToken;
    }
    if (!tokenCache.accessToken && process.env.TESLA_ACCESS_TOKEN) {
      return process.env.TESLA_ACCESS_TOKEN;
    }
  }
  return (await refreshAccessToken()) || process.env.TESLA_ACCESS_TOKEN || null;
}

/**
 * Normalize a Tesla media time value to milliseconds.
 * Fleet media fields are often reported in seconds (sometimes fractional).
 * Heuristic: values under 10_000 are treated as seconds; larger as ms.
 */
function toMs(value) {
  if (value == null || value === '' || Number.isNaN(Number(value))) {
    return 0;
  }
  const n = Number(value);
  if (n < 0) return 0;
  // Typical track durations: seconds < ~600 (10 min) to a few thousand;
  // elapsed similarly small. Values like 180.5 => seconds.
  // If somehow already ms (e.g. 180500), keep as ms.
  if (n < 10000) {
    return Math.round(n * 1000);
  }
  return Math.round(n);
}

/**
 * Fetch vehicle_data and extract a clean media_info payload.
 */
async function getMediaState() {
  const vehicleId = process.env.TESLA_VEHICLE_ID;
  let token = await getAccessToken();

  if (!token) {
    return {
      ok: false,
      error: 'missing_token',
      message:
        'No Tesla token available. Set TESLA_ACCESS_TOKEN, or set TESLA_REFRESH_TOKEN + TESLA_CLIENT_ID so the server can mint one.',
      media: null,
    };
  }

  if (!vehicleId) {
    return {
      ok: false,
      error: 'missing_vehicle_id',
      message: 'TESLA_VEHICLE_ID is not set.',
      media: null,
    };
  }

  const url = `${FLEET_BASE}/api/1/vehicles/${vehicleId}/vehicle_data`;

  const request = (bearer) =>
    axios.get(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true,
    });

  try {
    let res = await request(token);

    // An expired token looks like a 401; mint a fresh one and retry once.
    if ((res.status === 401 || res.status === 403) && canRefresh()) {
      const refreshed = await getAccessToken({ forceRefresh: true });
      if (refreshed && refreshed !== token) {
        token = refreshed;
        res = await request(token);
      }
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: 'unauthorized',
        message: canRefresh()
          ? 'Tesla API rejected the token even after a refresh. The refresh token may be revoked or expired — re-run OAuth.'
          : 'Tesla API rejected the access token. Re-authenticate (or set TESLA_REFRESH_TOKEN for automatic renewal).',
        status: res.status,
        media: null,
      };
    }

    // Vehicle asleep / unavailable
    if (res.status === 408 || res.status === 504) {
      return {
        ok: false,
        error: 'vehicle_asleep',
        message:
          'Vehicle is asleep or unreachable. Wake it from the Tesla app and retry.',
        status: res.status,
        media: null,
      };
    }

    if (res.status >= 400) {
      const detail =
        (res.data && (res.data.error || res.data.error_description)) ||
        res.statusText ||
        'unknown';
      return {
        ok: false,
        error: 'tesla_api_error',
        message: `Tesla API error (${res.status}): ${detail}`,
        status: res.status,
        media: null,
      };
    }

    const response = res.data && res.data.response ? res.data.response : res.data;
    const mi =
      (response && response.media_info) ||
      (response &&
        response.vehicle_state &&
        response.vehicle_state.media_info) ||
      {};

    const title = mi.now_playing_title || mi.now_playing_station || null;
    const artist = mi.now_playing_artist || null;
    const album = mi.now_playing_album || null;
    const durationMs = toMs(mi.now_playing_duration);
    const elapsedMs = toMs(mi.now_playing_elapsed);
    const status = mi.media_playback_status || 'Unknown';

    return {
      ok: true,
      media: {
        title,
        artist,
        album,
        durationMs,
        elapsedMs,
        playbackStatus: status,
        // Convenience flags
        isPlaying: String(status).toLowerCase() === 'playing',
        source: mi.now_playing_source || mi.source || null,
      },
      fetchedAt: Date.now(),
    };
  } catch (err) {
    const asleepHint =
      err.code === 'ECONNABORTED' ||
      (err.response && (err.response.status === 408 || err.response.status === 504));

    return {
      ok: false,
      error: asleepHint ? 'vehicle_asleep' : 'network_error',
      message: asleepHint
        ? 'Vehicle appears asleep or the request timed out.'
        : `Network error talking to Tesla Fleet API: ${err.message}`,
      media: null,
    };
  }
}


/**
 * Partner (client_credentials) token. Distinct from the user token: it
 * authenticates the application itself, not a vehicle owner, and is what
 * /api/1/partner_accounts requires.
 */
async function getPartnerToken() {
  const clientId = process.env.TESLA_CLIENT_ID;
  const clientSecret = process.env.TESLA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const missing = [
      !clientId && 'TESLA_CLIENT_ID',
      !clientSecret && 'TESLA_CLIENT_SECRET',
    ].filter(Boolean);
    throw new Error(`Missing ${missing.join(' and ')}.`);
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: process.env.TESLA_PARTNER_SCOPE || 'openid vehicle_device_data',
    audience: FLEET_BASE,
  });

  const res = await axios.post(AUTH_TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (res.status >= 400 || !res.data || !res.data.access_token) {
    const detail =
      (res.data && (res.data.error_description || res.data.error)) || res.statusText;
    throw new Error(`Partner token request failed (${res.status}): ${detail}`);
  }

  return res.data.access_token;
}

/**
 * The domain Tesla should associate with this app. Defaults to the host of
 * TESLA_REDIRECT_URI so there is one less env var to keep in sync.
 */
function partnerDomain() {
  if (process.env.TESLA_PARTNER_DOMAIN) {
    return process.env.TESLA_PARTNER_DOMAIN.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  const redirect = process.env.TESLA_REDIRECT_URI;
  if (!redirect) return null;
  try {
    return new URL(redirect).hostname;
  } catch {
    return null;
  }
}

/**
 * One-time registration of this app's domain with Tesla. Safe to repeat —
 * Tesla treats a re-register of the same domain as a no-op update.
 */
async function registerPartnerDomain() {
  const domain = partnerDomain();
  if (!domain) {
    return {
      ok: false,
      error: 'missing_domain',
      message:
        'Could not determine the domain. Set TESLA_PARTNER_DOMAIN, or set TESLA_REDIRECT_URI to your public https URL.',
    };
  }

  const token = await getPartnerToken();

  const res = await axios.post(
    `${FLEET_BASE}/api/1/partner_accounts`,
    { domain },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  if (res.status >= 400) {
    const detail =
      (res.data && (res.data.error_description || res.data.error || JSON.stringify(res.data))) ||
      res.statusText;
    return {
      ok: false,
      error: 'registration_failed',
      domain,
      status: res.status,
      message: `Tesla rejected the registration (${res.status}): ${detail}`,
      hint:
        res.status === 412 || res.status === 403
          ? `Tesla must be able to fetch https://${domain}/.well-known/appspecific/com.tesla.3p.public-key.pem — check that URL loads publicly first.`
          : undefined,
    };
  }

  return { ok: true, domain, status: res.status, response: res.data };
}

module.exports = {
  getMediaState,
  getPartnerToken,
  registerPartnerDomain,
  partnerDomain,
  getAccessToken,
  canRefresh,
  toMs,
};
