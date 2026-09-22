import React, { useCallback, useEffect, useRef, useState } from 'react';
import NowPlaying from './components/NowPlaying.jsx';
import LyricsView from './components/LyricsView.jsx';

const POLL_MS = 5000;

// Manual sync trim. Tesla reports elapsed time at whole-second resolution and
// the car's audio pipeline has its own latency, so a residual offset survives
// the round-trip compensation below and has to be dialled in by ear.
const OFFSET_STEP_MS = 250;
const OFFSET_LIMIT_MS = 10000;
const OFFSET_KEY = 'lyrics.offsetMs';

function loadOffset() {
  try {
    const raw = window.localStorage.getItem(OFFSET_KEY);
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, n)) : 0;
  } catch {
    return 0; // private mode / blocked storage
  }
}

function trackKey(media) {
  if (!media) return '';
  return `${media.title || ''}|${media.artist || ''}`;
}

export default function App() {
  const [media, setMedia] = useState(null);
  const [status, setStatus] = useState({ ok: false, message: 'Connecting…' });
  const [lyrics, setLyrics] = useState({ lines: [], plainLyrics: null, ok: false });
  const [lyricsStatus, setLyricsStatus] = useState('');
  const [currentPositionMs, setCurrentPositionMs] = useState(0);
  const [offsetMs, setOffsetMs] = useState(loadOffset);

  // Interpolation refs: anchor elapsed from last successful poll + wall clock
  const anchorElapsedMs = useRef(0);
  const anchorWallMs = useRef(Date.now());
  const isPlayingRef = useRef(false);
  const durationMsRef = useRef(0);
  const rafRef = useRef(0);
  const lastTrackKey = useRef('');

  useEffect(() => {
    try {
      window.localStorage.setItem(OFFSET_KEY, String(offsetMs));
    } catch {
      /* storage unavailable — offset still applies for this session */
    }
  }, [offsetMs]);

  const applyMediaPayload = useCallback((payload, rttMs = 0) => {
    if (!payload.ok || !payload.media) {
      setStatus({
        ok: false,
        message: payload.message || payload.error || 'No media',
        error: payload.error,
      });
      // Keep last media visible if we had one; still stop interpolating
      isPlayingRef.current = false;
      return;
    }

    const m = payload.media;
    setMedia(m);
    setStatus({ ok: true, message: m.playbackStatus || 'OK' });

    anchorElapsedMs.current = Number(m.elapsedMs) || 0;
    // elapsedMs was sampled mid-flight (car -> Tesla -> server -> here), so
    // backdate the anchor by half the round trip instead of treating the
    // reading as current. Without this every poll re-introduces the lag.
    anchorWallMs.current = Date.now() - Math.min(rttMs / 2, 3000);
    isPlayingRef.current = !!m.isPlaying;
    durationMsRef.current = Number(m.durationMs) || 0;
    setCurrentPositionMs(anchorElapsedMs.current);
  }, []);

  // Poll Tesla media state every 5s
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const startedAt = Date.now();
      try {
        const res = await fetch('/api/media_state');
        const data = await res.json();
        if (!cancelled) applyMediaPayload(data, Date.now() - startedAt);
      } catch (err) {
        if (!cancelled) {
          setStatus({
            ok: false,
            message: `Media poll failed: ${err.message}`,
            error: 'network_error',
          });
          isPlayingRef.current = false;
        }
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [applyMediaPayload]);

  // rAF interpolate position while Playing
  useEffect(() => {
    function tick() {
      if (isPlayingRef.current) {
        const delta = Date.now() - anchorWallMs.current;
        let next = anchorElapsedMs.current + delta;
        const dur = durationMsRef.current;
        if (dur > 0 && next > dur) next = dur;
        setCurrentPositionMs(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Fetch lyrics when title/artist change
  useEffect(() => {
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
          setLyrics({ lines: [], plainLyrics: null, ok: false });
          setLyricsStatus(`Lyrics error: ${err.message}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [media]);

  return (
    <div className="relative flex h-full w-full flex-col bg-black text-white">
      <NowPlaying media={media} status={status} positionMs={currentPositionMs} />
      <div className="min-h-0 flex-1">
        <LyricsView
          lines={lyrics.lines}
          plainLyrics={lyrics.plainLyrics}
          currentPositionMs={currentPositionMs + offsetMs}
          statusMessage={lyricsStatus}
        />
      </div>
      <SyncControls offsetMs={offsetMs} onChange={setOffsetMs} />
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

  // Big, flat, opacity-only hover: the Tesla browser stutters on anything
  // heavier and fingers need a target this size.
  const button =
    'h-14 w-14 rounded-full bg-white/10 text-2xl font-bold text-white active:bg-white/25';

  return (
    <div className="pointer-events-auto absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-full bg-black/70 p-2">
      <button className={button} onClick={() => nudge(-OFFSET_STEP_MS)} aria-label="Lyrics later">
        −
      </button>
      <button
        className="min-w-[5rem] px-2 text-center text-base font-medium text-gray-300 active:text-white"
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
