'use strict';

const axios = require('axios');
const { kvGetJson, kvSetJson } = require('./kv');

const LRCLIB_BASE = process.env.LRCLIB_BASE || 'https://lrclib.net/api';
// LRCLIB asks clients to identify themselves with a reachable homepage.
const USER_AGENT = 'Teslyr/1.1 (https://github.com/Jareedd/Genesis)';

/**
 * Parse LRC synced lyrics into [{ timeMs, text }].
 * Supports [mm:ss.xx] and [mm:ss.xxx] timestamps.
 */
function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') {
    return [];
  }

  const lines = [];
  const timeTag = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const raw of lrcText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const tags = [...line.matchAll(timeTag)];
    if (tags.length === 0) continue;

    const text = line.replace(timeTag, '').trim();
    // Skip empty metadata-only lines unless they have displayable text
    if (!text) continue;

    for (const m of tags) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      let frac = m[3] || '0';
      // Normalize fractional part to milliseconds
      if (frac.length === 1) frac = frac + '00';
      else if (frac.length === 2) frac = frac + '0';
      else if (frac.length > 3) frac = frac.slice(0, 3);
      const ms = parseInt(frac, 10);
      const timeMs = minutes * 60 * 1000 + seconds * 1000 + ms;
      lines.push({ timeMs, text });
    }
  }

  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
}

// ---------------------------------------------------------------------------
// Title / artist normalisation
//
// Streaming services decorate metadata in ways LRCLIB's catalogue often
// doesn't: "Song (feat. X)", "Song - Remastered 2011", "A, B & C". These are
// only used for fallback lookups — the exact metadata is always tried first,
// because the decorated title is sometimes the one with the right timing.
// ---------------------------------------------------------------------------

const VERSION_WORDS =
  'remaster(?:ed)?|remix|live|version|edit|mono|stereo|deluxe|bonus|explicit|clean|' +
  'single|radio|acoustic|anniversary|from|demo|instrumental|extended|sped up|slowed';

function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(new RegExp(`\\s+-\\s+[^-]*\\b(?:${VERSION_WORDS})\\b.*$`, 'i'), '')
    .replace(new RegExp(`\\s*[([][^)\\]]*\\b(?:${VERSION_WORDS})\\b[^)\\]]*[)\\]]`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// First credited artist. Deliberately does not split on "and" or "x" — that
// would mangle "Florence and the Machine" or "Lil Nas X".
function primaryArtist(artist) {
  return String(artist || '')
    .split(/\s*(?:,|;|\/|&|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s|\bwith\s)\s*/i)[0]
    .trim();
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// LRCLIB transport
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [400, 1200];
const PER_REQUEST_TIMEOUT_MS = 6000;
const OVERALL_BUDGET_MS = 11000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One LRCLIB request, retried on 5xx / network failure. LRCLIB is a free
 * community service with intermittent 502/503s; a single blip used to cost
 * the whole track. Returns { status, data } or { status: 'unavailable' }.
 */
async function lrclib(path, params, deadline) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 500) return { status: 'unavailable' };

    try {
      const res = await axios.get(`${LRCLIB_BASE}/${path}`, {
        params,
        headers: { 'User-Agent': USER_AGENT },
        timeout: Math.min(PER_REQUEST_TIMEOUT_MS, remaining),
        validateStatus: () => true,
      });
      if (res.status < 500) return { status: res.status, data: res.data };
      console.warn(`[tesla-lyrics] LRCLIB ${path} ${res.status} (attempt ${attempt + 1})`);
    } catch (err) {
      console.warn(`[tesla-lyrics] LRCLIB ${path} ${err.code || err.message} (attempt ${attempt + 1})`);
    }

    const wait = RETRY_DELAYS_MS[attempt];
    if (wait == null || Date.now() + wait > deadline) break;
    await sleep(wait);
  }
  return { status: 'unavailable' };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function hasLyrics(rec) {
  return Boolean(rec && (rec.syncedLyrics || rec.plainLyrics || rec.instrumental));
}

/**
 * Rank a search candidate. Synced lyrics dominate; then artist and title
 * agreement; then duration, which is what separates the album cut from a
 * live or extended version with different timing.
 */
function scoreCandidate(c, want) {
  let score = 0;
  if (c.syncedLyrics) score += 100;
  else if (c.plainLyrics) score += 25;
  else if (c.instrumental) score += 10;

  const artistOk =
    norm(c.artistName).includes(norm(want.artist)) ||
    norm(want.fullArtist).includes(norm(c.artistName));
  if (artistOk) score += 40;

  const t = norm(c.trackName);
  if (t === norm(want.title)) score += 35;
  else if (t === norm(want.fullTitle)) score += 35;
  else if (t.includes(norm(want.title)) || norm(want.title).includes(t)) score += 12;

  if (want.durationSec && c.duration) {
    const diff = Math.abs(c.duration - want.durationSec);
    score += Math.max(0, 25 - diff * 2.5);
    if (diff > 20) score -= 60; // almost certainly a different recording
  }

  return { score, artistOk };
}

function pickBest(candidates, want) {
  let best = null;
  for (const c of candidates || []) {
    if (!hasLyrics(c)) continue;
    const { score, artistOk } = scoreCandidate(c, want);
    // Never accept a candidate whose artist doesn't line up: a confident
    // wrong song is worse than "no lyrics".
    if (!artistOk) continue;
    if (!best || score > best.score) best = { rec: c, score };
  }
  return best && best.score >= 60 ? best.rec : null;
}

// ---------------------------------------------------------------------------
// Cache: in-process LRU in front of Upstash (shared with the token store).
// Repeat plays are instant and survive LRCLIB being down entirely.
// ---------------------------------------------------------------------------

const MEMO_LIMIT = 300;
const memo = new Map();
const HIT_TTL_S = 30 * 24 * 3600; // lyrics don't change
const MISS_TTL_S = 6 * 3600; // retry genuine misses later; LRCLIB grows

function cacheKey(title, artist) {
  return `teslyr:lyrics:v1:${norm(cleanTitle(title))}|${norm(primaryArtist(artist))}`;
}

function memoGet(key) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memo.delete(key);
    return null;
  }
  memo.delete(key); // refresh recency
  memo.set(key, hit);
  return hit.value;
}

function memoSet(key, value, ttlS) {
  memo.set(key, { value, expires: Date.now() + ttlS * 1000 });
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value);
}

async function cacheGet(key) {
  const local = memoGet(key);
  if (local) return local;
  const remote = await kvGetJson(key);
  if (remote) memoSet(key, remote, remote.ok ? HIT_TTL_S : MISS_TTL_S);
  return remote;
}

function cacheSet(key, value) {
  const ttl = value.ok ? HIT_TTL_S : MISS_TTL_S;
  memoSet(key, value, ttl);
  kvSetJson(key, value, ttl); // fire and forget — never delay a response on it
}

// ---------------------------------------------------------------------------

function toResult(rec, via) {
  const lines = rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [];
  const plain = rec.plainLyrics || null;
  return {
    ok: true,
    lines,
    plainLyrics: plain,
    instrumental: !!rec.instrumental,
    meta: {
      id: rec.id,
      name: rec.trackName || rec.name,
      artistName: rec.artistName,
      albumName: rec.albumName,
      duration: rec.duration,
      via,
    },
  };
}

/**
 * Find lyrics for a track. Lookup order, cheapest and most exact first:
 *   1. cache
 *   2. /get with the exact metadata (+ duration when known)
 *   3. /get with cleaned title and primary artist
 *   4. /search by fields, best-scored candidate
 *   5. /search free text, best-scored candidate
 * A plain-text /get hit is held back while search looks for a synced version.
 */
async function fetchLyrics({ title, artist, duration } = {}) {
  if (!title || !artist) {
    return {
      ok: false,
      error: 'missing_params',
      message: 'Both title and artist are required.',
      lines: [],
      plainLyrics: null,
    };
  }

  const key = cacheKey(title, artist);
  const cached = await cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const deadline = Date.now() + OVERALL_BUDGET_MS;
  const durationSec =
    duration != null && Number(duration) > 0 ? Math.round(Number(duration)) : undefined;

  const want = {
    title: cleanTitle(title) || title,
    fullTitle: title,
    artist: primaryArtist(artist) || artist,
    fullArtist: artist,
    durationSec,
  };

  // Once an endpoint is down, stop spending the time budget on it: skip
  // straight to the next kind of lookup.
  let getDown = false;
  let searchDown = false;
  let plainFallback = null;

  const consider = (rec, via) => {
    if (!hasLyrics(rec)) return null;
    if (rec.syncedLyrics || rec.instrumental) return toResult(rec, via);
    if (!plainFallback) plainFallback = toResult(rec, via);
    return null;
  };

  const tryGet = async (params, via) => {
    if (getDown) return null;
    const r = await lrclib('get', params, deadline);
    if (r.status === 'unavailable') getDown = true;
    return r.status === 200 ? consider(r.data, via) : null;
  };

  const trySearch = async (params, via) => {
    if (searchDown) return null;
    const r = await lrclib('search', params, deadline);
    if (r.status === 'unavailable') {
      searchDown = true;
      return null;
    }
    if (r.status !== 200 || !Array.isArray(r.data)) return null;
    const best = pickBest(r.data, want);
    return best ? consider(best, via) : null;
  };

  const exact = { track_name: title, artist_name: artist };
  const steps = [
    () => tryGet(durationSec ? { ...exact, duration: durationSec } : exact, 'get'),
  ];
  if (durationSec) steps.push(() => tryGet(exact, 'get-nodur'));
  if (want.title !== title || want.artist !== artist) {
    steps.push(() => tryGet({ track_name: want.title, artist_name: want.artist }, 'get-clean'));
  }
  steps.push(() => trySearch({ track_name: want.title, artist_name: want.artist }, 'search'));
  steps.push(() => trySearch({ q: `${want.title} ${want.artist}` }, 'search-q'));

  for (const step of steps) {
    if (Date.now() > deadline) break;
    const result = await step();
    if (result) {
      cacheSet(key, result);
      return result;
    }
  }

  // Search is the broadest lookup. If it never gave a real answer, a miss
  // here means "couldn't check", not "doesn't exist".
  const inconclusive = searchDown || Date.now() > deadline;

  if (plainFallback) {
    // Only pin a plain-text result once we know there's no synced one.
    if (!inconclusive) cacheSet(key, plainFallback);
    return plainFallback;
  }

  if (inconclusive) {
    return {
      ok: false,
      error: 'lrclib_unavailable',
      retryable: true,
      message: 'Lyrics service is busy — retrying…',
      lines: [],
      plainLyrics: null,
    };
  }

  const miss = {
    ok: false,
    error: 'not_found',
    message: 'No lyrics found for this track.',
    lines: [],
    plainLyrics: null,
  };
  cacheSet(key, miss);
  return miss;
}

module.exports = {
  parseLrc,
  fetchLyrics,
  cleanTitle,
  primaryArtist,
  pickBest,
};
