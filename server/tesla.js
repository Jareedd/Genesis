'use strict';

const axios = require('axios');

const FLEET_BASE =
  process.env.TESLA_FLEET_BASE_URL ||
  'https://fleet-api.prd.na.vn.cloud.tesla.com';

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
  const token = process.env.TESLA_ACCESS_TOKEN;
  const vehicleId = process.env.TESLA_VEHICLE_ID;

  if (!token) {
    return {
      ok: false,
      error: 'missing_token',
      message:
        'TESLA_ACCESS_TOKEN is not set. Complete OAuth and set the token in .env.',
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

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: 'unauthorized',
        message: 'Tesla API rejected the access token. Re-authenticate.',
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

module.exports = {
  getMediaState,
  toMs,
};
