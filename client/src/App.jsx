import React, { useCallback, useEffect, useRef, useState } from 'react';
import NowPlaying from './components/NowPlaying.jsx';
import LyricsView from './components/LyricsView.jsx';

const POLL_MS = 5000;

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

export default function App() {
  const [media, setMedia] = useState(null);
  const [status, setStatus] = useState({ ok: false, message: 'Connecting…' });
  const [lyrics, setLyrics] = useState({ lines: [], plainLyrics: null, ok: false });
  const [lyricsStatus, setLyricsStatus] = useState('');
  const [currentPositionMs, setCurrentPositionMs] = useState(0);
  const demo = useRef(isDemoMode()).current;

  const anchorElapsedMs = useRef(0);
  const anchorWallMs = useRef(Date.now());
  const isPlayingRef = useRef(false);
  const durationMsRef = useRef(0);
  const rafRef = useRef(0);
  const lastTrackKey = useRef('');

  const applyMediaPayload = useCallback((payload) => {
    if (!payload.ok || !payload.media) {
      setStatus({
        ok: false,
        message: payload.message || payload.error || 'No media',
        error: payload.error,
      });
      isPlayingRef.current = false;
      return;
    }

    const m = payload.media;
    setMedia(m);
    setStatus({ ok: true, message: m.playbackStatus || 'OK' });

    anchorElapsedMs.current = Number(m.elapsedMs) || 0;
    anchorWallMs.current = Date.now();
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

  // Poll Tesla media state every 5s
  useEffect(() => {
    if (demo) return undefined;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch('/api/media_state');
        const data = await res.json();
        if (!cancelled) applyMediaPayload(data);
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
  }, [applyMediaPayload, demo]);

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

  return (
    <div className="teslyr-stage relative flex h-full w-full flex-col text-white">
      <div className="teslyr-grid pointer-events-none absolute inset-0" aria-hidden />

      <NowPlaying media={media} status={status} positionMs={currentPositionMs} />

      <div className="relative min-h-0 flex-1">
        <LyricsView
          lines={lyrics.lines}
          plainLyrics={lyrics.plainLyrics}
          currentPositionMs={currentPositionMs}
          statusMessage={lyricsStatus}
          showBrandHero={!hasTrack && !lyrics.lines.length}
        />
      </div>
    </div>
  );
}
