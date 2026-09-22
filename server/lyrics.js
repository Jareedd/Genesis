'use strict';

const axios = require('axios');

const LRCLIB_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'TeslaLyricsApp/1.0 (https://github.com/local/tesla-lyrics-app)';

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

/**
 * Fetch synced lyrics from LRCLIB.
 * @param {{ title: string, artist: string, duration?: number }} params
 *   duration is track length in seconds (optional, improves match).
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

  const params = {
    track_name: title,
    artist_name: artist,
  };
  if (duration != null && !Number.isNaN(Number(duration)) && Number(duration) > 0) {
    // LRCLIB expects duration in seconds
    params.duration = Math.round(Number(duration));
  }

  try {
    const res = await axios.get(`${LRCLIB_BASE}/get`, {
      params,
      headers: {
        'User-Agent': USER_AGENT,
      },
      timeout: 12000,
      validateStatus: () => true,
    });

    if (res.status === 404) {
      return {
        ok: false,
        error: 'not_found',
        message: 'No lyrics found on LRCLIB for this track.',
        lines: [],
        plainLyrics: null,
      };
    }

    if (res.status >= 400) {
      return {
        ok: false,
        error: 'lrclib_error',
        message: `LRCLIB error (${res.status})`,
        lines: [],
        plainLyrics: null,
      };
    }

    const data = res.data || {};
    const synced = data.syncedLyrics || null;
    const plain = data.plainLyrics || null;
    const lines = synced ? parseLrc(synced) : [];

    if (lines.length === 0 && !plain) {
      return {
        ok: false,
        error: 'no_lyrics_body',
        message: 'LRCLIB returned a match but no lyric text.',
        lines: [],
        plainLyrics: null,
        meta: {
          id: data.id,
          name: data.name,
          artistName: data.artistName,
          albumName: data.albumName,
          duration: data.duration,
        },
      };
    }

    return {
      ok: true,
      lines,
      plainLyrics: plain,
      instrumental: !!data.instrumental,
      meta: {
        id: data.id,
        name: data.name,
        artistName: data.artistName,
        albumName: data.albumName,
        duration: data.duration,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      message: `Failed to reach LRCLIB: ${err.message}`,
      lines: [],
      plainLyrics: null,
    };
  }
}

module.exports = {
  parseLrc,
  fetchLyrics,
};
