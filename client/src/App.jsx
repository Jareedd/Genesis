import React, { useCallback, useEffect, useRef, useState } from 'react';
import NowPlaying from './components/NowPlaying.jsx';
import LyricsView from './components/LyricsView.jsx';

const POLL_MS = 5000;

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

  // Interpolation refs: anchor elapsed from last successful poll + wall clock
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
      // Keep last media visible if we had one; still stop interpolating
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

  // Poll Tesla media state every 5s
  useEffect(() => {
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
    <div className="flex h-full w-full flex-col bg-black text-white">
      <NowPlaying media={media} status={status} positionMs={currentPositionMs} />
      <div className="min-h-0 flex-1">
        <LyricsView
          lines={lyrics.lines}
          plainLyrics={lyrics.plainLyrics}
          currentPositionMs={currentPositionMs}
          statusMessage={lyricsStatus}
        />
      </div>
    </div>
  );
}
