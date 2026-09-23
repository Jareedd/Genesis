import React, { useCallback, useEffect, useRef, useState } from 'react';
import NowPlaying from './components/NowPlaying.jsx';
import LyricsView from './components/LyricsView.jsx';

const POLL_MS = 5000;
// Poll harder around a track change (that boundary is what users notice) and
// back off when nothing is playing, so the adaptive schedule costs fewer Fleet
// API requests overall than a flat 5s loop.
const FAST_POLL_MS = 1500;
const PAUSED_POLL_MS = 6000;
const ERROR_POLL_MS = 15000;
const TRACK_END_WINDOW_MS = 4000;
// A vehicle_data call takes ~1s warm but 10s+ when the car is waking. Cap it so
// one slow request can't stall the loop.
const REQUEST_TIMEOUT_MS = 12000;

// Manual sync trim. Tesla reports elapsed time at whole-second resolution and
// the cabin audio path adds its own latency, so a residual offset survives the
// round-trip compensation below and has to be dialled in by ear.
const OFFSET_STEP_MS = 250;
const OFFSET_LIMIT_MS = 10000;
const OFFSET_KEY = 'lyrics.offsetMs';

function loadOffset() {
  try {
    const raw = window.localStorage.getItem(OFFSET_KEY);
    const n = Number(raw);
    return Number.isFinite(n)
      ? Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, n))
      : 0;
  } catch {
    return 0; // private mode / blocked storage
  }
}

const DEMO_LINES = [
  { timeMs: 0, text: 'Night highway, cabin glow' },
  { timeMs: 3200, text: 'Bass under the glass roof' },
  { timeMs: 6400, text: 'Every line lights with the beat' },
  { timeMs: 9600, text: 'Teslyr keeps the words in view' },
  { timeMs: 12800, text: 'Crimson pulse on every verse' },
  { timeMs: 16000, text: 'Drive on — stay in sync' },
  { timeMs: 19200, text: 'Nothing between you and the song' },
  { timeMs: 22400, text: 'Just the road and the lyric' },
];

function isDemoMode() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('demo');
}

function trackKey(media) {
  if (!media) return '';
  return `${media.title || ''}|${media.artist || ''}`;
}

// Spotify-style: derive a vibrant, immersive background color per track (stands
// in for the cover-art color, which the Fleet API doesn't expose).
function trackBackground(media) {
  if (!media?.title) return null;
  const key = `${media.title}|${media.artist || ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return (
    `radial-gradient(120% 80% at 15% 0%, hsl(${hue} 70% 42%) 0%, transparent 60%),` +
    `linear-gradient(180deg, hsl(${hue} 58% 30%) 0%, hsl(${hue} 62% 18%) 45%, hsl(${hue} 68% 8%) 100%)`
  );
}

export default function App() {
  const [media, setMedia] = useState(null);
  const [status, setStatus] = useState({ ok: false, message: 'Connecting…' });
  const [lyrics, setLyrics] = useState({ lines: [], plainLyrics: null, ok: false });
  const [lyricsStatus, setLyricsStatus] = useState('');
  const [currentPositionMs, setCurrentPositionMs] = useState(0);
  const [offsetMs, setOffsetMs] = useState(loadOffset);
  const [awaitingNext, setAwaitingNext] = useState(false);
  const demo = useRef(isDemoMode()).current;

  const anchorElapsedMs = useRef(0);
  const anchorWallMs = useRef(Date.now());
  const isPlayingRef = useRef(false);
  const durationMsRef = useRef(0);
  const rafRef = useRef(0);
  const lastTrackKey = useRef('');
  const lastPollOkRef = useRef(true);
  const endedRef = useRef(false);
  const lastAnchoredKey = useRef('');

  useEffect(() => {
    try {
      window.localStorage.setItem(OFFSET_KEY, String(offsetMs));
    } catch {
      /* storage unavailable — offset still applies for this session */
    }
  }, [offsetMs]);

  const applyMediaPayload = useCallback((payload, rttMs = 0) => {
    if (!payload.ok || !payload.media) {
      lastPollOkRef.current = false;
      setStatus({
        ok: false,
        message: payload.message || payload.error || 'No media',
        error: payload.error,
      });
      isPlayingRef.current = false;
      return;
    }

    lastPollOkRef.current = true;
    const m = payload.media;

    // A new track restarts the clock. Without this the previous song's
    // extrapolated position survives into the new one, so the bar opens full
    // and the last line of the old lyrics shows as active.
    if (trackKey(m) !== lastAnchoredKey.current) {
      lastAnchoredKey.current = trackKey(m);
      endedRef.current = false;
      setAwaitingNext(false);
    }

    setMedia(m);
    setStatus({ ok: true, message: m.playbackStatus || 'OK' });

    anchorElapsedMs.current = Number(m.elapsedMs) || 0;
    // elapsedMs was sampled mid-flight (car -> Tesla -> server -> here), so
    // backdate the anchor by half the round trip rather than treating the
    // reading as current. Without this every poll re-introduces the lag.
    anchorWallMs.current = Date.now() - Math.min(rttMs / 2, 3000);
    isPlayingRef.current = !!m.isPlaying;
    durationMsRef.current = Number(m.durationMs) || 0;
    setCurrentPositionMs(anchorElapsedMs.current);
  }, []);

  // Demo preview — no Tesla token required (?demo=1)
  useEffect(() => {
    if (!demo) return;
    const durationMs = 28000;
    setMedia({
      title: 'Midnight Autopilot',
      artist: 'Teslyr Demo',
      album: 'Cabin Sessions',
      durationMs,
      elapsedMs: 0,
      playbackStatus: 'Playing',
      isPlaying: true,
      source: 'demo',
    });
    setStatus({ ok: true, message: 'Playing' });
    setLyrics({ lines: DEMO_LINES, plainLyrics: null, ok: true });
    setLyricsStatus('');
    anchorElapsedMs.current = 0;
    anchorWallMs.current = Date.now();
    isPlayingRef.current = true;
    durationMsRef.current = durationMs;
    lastTrackKey.current = 'Midnight Autopilot|Teslyr Demo';
  }, [demo]);

  // Poll Tesla media state on a self-scheduling loop. setInterval would stack
  // requests whenever a call outran the interval, and those replies land out of
  // order — an older elapsed value overwriting a newer one drags the position
  // backwards. Scheduling the next poll only after the last one settles makes
  // overlap impossible.
  useEffect(() => {
    if (demo) return undefined;
    let cancelled = false;
    let timer = 0;

    function nextDelay() {
      // Asleep or unreachable: back right off. Paused is different — someone is
      // sitting there and will hit play, so keep that responsive.
      if (!lastPollOkRef.current) return ERROR_POLL_MS;
      if (!isPlayingRef.current) return PAUSED_POLL_MS;
      const dur = durationMsRef.current;
      if (dur > 0) {
        const position =
          anchorElapsedMs.current + (Date.now() - anchorWallMs.current);
        if (dur - position <= TRACK_END_WINDOW_MS) return FAST_POLL_MS;
      }
      return POLL_MS;
    }

    async function poll() {
      const startedAt = Date.now();
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch('/api/media_state', { signal: controller.signal });
        const data = await res.json();
        if (!cancelled) applyMediaPayload(data, Date.now() - startedAt);
      } catch (err) {
        if (!cancelled) {
          lastPollOkRef.current = false;
          setStatus({
            ok: false,
            message:
              err.name === 'AbortError'
                ? 'Vehicle slow to respond…'
                : `Media poll failed: ${err.message}`,
            error: 'network_error',
          });
          isPlayingRef.current = false;
        }
      } finally {
        clearTimeout(abortTimer);
      }

      if (!cancelled) timer = setTimeout(poll, nextDelay());
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [applyMediaPayload, demo]);

  // rAF interpolate position while Playing
  useEffect(() => {
    function tick() {
      if (isPlayingRef.current) {
        const delta = Date.now() - anchorWallMs.current;
        let next = anchorElapsedMs.current + delta;
        const dur = durationMsRef.current;
        if (dur > 0 && next > dur) {
          if (demo) {
            // Loop demo so visual QA / cabin preview never freezes on the last line
            anchorElapsedMs.current = 0;
            anchorWallMs.current = Date.now();
            next = 0;
          } else {
            next = dur;
            // Past the end with no new track yet: hand over to a transitional
            // state rather than holding the final line lit under a full bar.
            if (!endedRef.current) {
              endedRef.current = true;
              setAwaitingNext(true);
            }
          }
        }
        setCurrentPositionMs(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [demo]);

  // Fetch lyrics when title/artist change
  useEffect(() => {
    if (demo) return undefined;
    const key = trackKey(media);
    if (!key || key === '|' || key === lastTrackKey.current) return;
    if (!media?.title || !media?.artist) {
      setLyrics({ lines: [], plainLyrics: null, ok: false });
      setLyricsStatus('Waiting for title & artist…');
      return;
    }

    lastTrackKey.current = key;
    let cancelled = false;
    setLyricsStatus('Fetching lyrics…');
    setLyrics({ lines: [], plainLyrics: null, ok: false });

    const durationSec =
      media.durationMs > 0 ? Math.round(media.durationMs / 1000) : undefined;
    const qs = new URLSearchParams({
      title: media.title,
      artist: media.artist,
    });
    if (durationSec) qs.set('duration', String(durationSec));

    (async () => {
      try {
        const res = await fetch(`/api/lyrics?${qs.toString()}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.ok) {
          setLyrics({
            lines: data.lines || [],
            plainLyrics: data.plainLyrics || null,
            ok: true,
            instrumental: data.instrumental,
          });
          setLyricsStatus(
            data.instrumental
              ? 'Instrumental'
              : data.lines?.length
                ? ''
                : 'Unsynced lyrics only'
          );
        } else {
          setLyrics({ lines: [], plainLyrics: null, ok: false });
          setLyricsStatus(data.message || 'No lyrics found');
        }
      } catch (err) {
        if (!cancelled) {
          // Release the claim so the next poll retries instead of leaving the
          // track permanently lyric-less after one transient failure.
          lastTrackKey.current = '';
          setLyrics({ lines: [], plainLyrics: null, ok: false });
          setLyricsStatus(`Lyrics error: ${err.message}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [media, demo]);

  const hasTrack = Boolean(media?.title);
  const trackBg = trackBackground(media);

  return (
    <div
      className="teslyr-stage relative flex h-full w-full flex-col text-white transition-[background] duration-700 ease-out"
      style={trackBg ? { background: trackBg } : undefined}
    >
      <div className="teslyr-grid pointer-events-none absolute inset-0" aria-hidden />

      <NowPlaying media={media} status={status} positionMs={currentPositionMs} />

      <div className="relative min-h-0 flex-1">
        <LyricsView
          lines={awaitingNext ? [] : lyrics.lines}
          plainLyrics={awaitingNext ? null : lyrics.plainLyrics}
          currentPositionMs={currentPositionMs + offsetMs}
          statusMessage={awaitingNext ? 'Up next…' : lyricsStatus}
          showBrandHero={!hasTrack && !lyrics.lines.length}
        />
      </div>

      {hasTrack && <SyncControls offsetMs={offsetMs} onChange={setOffsetMs} />}
    </div>
  );
}

function SyncControls({ offsetMs, onChange }) {
  const nudge = (delta) =>
    onChange(
      Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, offsetMs + delta))
    );

  const label =
    offsetMs === 0
      ? 'Sync'
      : `${offsetMs > 0 ? '+' : ''}${(offsetMs / 1000).toFixed(2)}s`;

  // Flat active states, no hover or blur: the cabin browser stutters on heavy
  // CSS and a touchscreen has no hover. 56px targets for gloved taps.
  const button =
    'h-14 w-14 rounded-full bg-white/10 font-display text-2xl font-bold ' +
    'leading-none text-white active:bg-white/25';

  return (
    <div className="absolute bottom-5 right-5 z-20 flex items-center gap-2 rounded-full bg-black/55 p-2">
      <button className={button} onClick={() => nudge(-OFFSET_STEP_MS)} aria-label="Lyrics later">
        −
      </button>
      <button
        className="min-w-[4.5rem] px-1 text-center text-sm font-semibold uppercase tracking-[0.14em] text-teslyr-soft active:text-white"
        onClick={() => onChange(0)}
        aria-label="Reset sync"
      >
        {label}
      </button>
      <button className={button} onClick={() => nudge(OFFSET_STEP_MS)} aria-label="Lyrics earlier">
        +
      </button>
    </div>
  );
}
