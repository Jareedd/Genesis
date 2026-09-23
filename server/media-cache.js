'use strict';

// Short-lived cache in front of the Fleet API. Rapid polls and multiple cabin
// tabs collapse into a single upstream vehicle_data call, which keeps the
// number of billed Tesla requests down. Only successful reads are cached so
// transient errors retry promptly.
const DEFAULT_TTL_MS = Number(process.env.MEDIA_CACHE_TTL_MS) || 2000;

let entry = null; // { value, expiresAt }
let inflight = null;

async function getMediaCached(loader, ttlMs = DEFAULT_TTL_MS) {
  if (entry && Date.now() < entry.expiresAt) return entry.value;
  if (inflight) return inflight;

  inflight = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (value && value.ok) entry = { value, expiresAt: Date.now() + ttlMs };
      return value;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

function clearMediaCache() {
  entry = null;
}

module.exports = { getMediaCached, clearMediaCache };
