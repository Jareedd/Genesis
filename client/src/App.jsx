import React, { useCallback, useEffect, useRef, useState } from 'react';
import NowPlaying from './components/NowPlaying.jsx';
import LyricsView from './components/LyricsView.jsx';
import OwnerGate from './components/OwnerGate.jsx';

const POLL_MS = 5000;
// Poll harder around a track change (that boundary is what users notice) and
// back off when nothing is playing, so the adaptive schedule costs fewer Fleet
// API requests overall than a flat 5s loop.
const FAST_POLL_MS = 1500;
const PAUSED_POLL_MS = 6000;
const ERROR_POLL_MS = 15000;
// Our own server being briefly unreachable (Render waking or redeploying)
// costs no Tesla API calls, so there's no reason to back off as far as for an
// asleep car. Doubles per consecutive failure up to the cap.
const SERVER_RETRY_MS = 2500;
const SERVER_RETRY_MAX_MS = 10000;
const TRACK_END_WINDOW_MS = 4000;
// A vehicle_data call takes ~1s warm but 10s+ when the car is waking. Cap it so
// one slow request can't stall the loop.
const REQUEST_TIMEOUT_MS = 12000;
// How often the position clock re-renders. The active lyric line only needs
// ~100ms resolution; updating every animation frame re-rendered the whole tree
// ~60x/second, which the in-car browser can't sustain over a long drive.
const POSITION_STEP_MS = 100;
// The server spends up to ~11s on its own LRCLIB retries and fallbacks, so the
// client must wait longer than that or it abandons lookups that would succeed.
const LYRICS_TIMEOUT_MS = 15000;
// Backoff between client attempts. Covers roughly a minute of LRCLIB outage
// before giving up, and each attempt already includes the server's retries.
const LYRICS_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 20000];
// Never let the end-of-track handover become a dead end.
const AWAITING_MAX_MS = 10000;

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
  const trackId = trackKey(media);
  const demo = useRef(isDemoMode()).current;
  // Owner-login gate. Demo mode is a token-free preview, so it skips the gate.
  const [auth, setAuth] = useState({
    checked: false,
    configured: false,
    authenticated: false,
    usernameRequired: false,
  });

  const anchorElapsedMs = useRef(0);
  const anchorWallMs = useRef(Date.now());
  const isPlayingRef = useRef(false);
  const durationMsRef = useRef(0);
  const rafRef = useRef(0);
  const lastPushedRef = useRef(-1);
  const lastTrackKey = useRef('');
  const lastPollOkRef = useRef(true);
  // Delay override for the next poll after a server-side failure; 0 = none.
  const serverRetryRef = useRef(0);
  const endedRef = useRef(false);
  const lastAnchoredKey = useRef('');
  const mediaRef = useRef(null);
  const prevElapsedRef = useRef(-1);
  // Latches once the handover has been given up on, so the rAF loop below
  // cannot immediately re-enter it. Cleared only by an actual track change.
  const handoverExpiredRef = useRef(false);

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
      handoverExpiredRef.current = false;
      prevElapsedRef.current = -1;
      setAwaitingNext(false);
    }

    // Recover from the end-of-track handover when the same track keeps playing
    // (Tesla's reported duration can be short or plain wrong), otherwise the
    // transitional state sticks until the track changes.
    const dur = Number(m.durationMs) || 0;
    const el = Number(m.elapsedMs) || 0;
    // Elapsed still climbing means the track is genuinely still playing, even
    // if it has run past the duration Tesla reported — that reading is not
    // always right, and trusting it alone strands the handover state.
    const advanced = el > prevElapsedRef.current + 250;
    prevElapsedRef.current = el;
    if (dur === 0 || el < dur - 1500 || advanced) {
      endedRef.current = false;
      setAwaitingNext(false);
    }

    mediaRef.current = m;
    setMedia(m);
    setStatus({ ok: true, message: m.playbackStatus || 'OK' });

    anchorElapsedMs.current = Number(m.elapsedMs) || 0;
    // elapsedMs was sampled mid-flight (car -> Tesla -> server -> here), so
    // backdate the anchor by half the round trip rather than treating the
    // reading as current. Without this every poll re-introduces the lag.
    anchorWallMs.current = Date.now() - Math.min(rttMs / 2, 3000);
    isPlayingRef.current = !!m.isPlaying;
    durationMsRef.current = Number(m.durationMs) || 0;
    lastPushedRef.current = anchorElapsedMs.current;
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

  // Check the owner session (skipped in demo), retrying until the server
  // actually answers.
  //
  // This used to run once and, on any failure, mark the session "checked"
  // with configured=false — which renders the gate's "login isn't configured"
  // screen, a dead end with no PIN field. Render's proxy answers 502/503
  // while the service wakes from free-tier sleep or redeploys, so landing
  // during either stranded the app there until a manual reload.
  useEffect(() => {
    if (demo) return undefined;
    if (auth.checked) return undefined;
    let cancelled = false;
    let timer = 0;
    let delay = 2000;

    (async function check() {
      try {
        const res = await fetch('/api/session');
        if (res.status >= 500) throw new Error(`server ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setAuth({
          checked: true,
          configured: !!data.configured,
          authenticated: !!data.authenticated,
          usernameRequired: !!data.usernameRequired,
        });
      } catch {
        if (cancelled) return;
        setStatus({ ok: false, message: 'Server waking up…', error: 'network_error' });
        timer = setTimeout(check, delay);
        // /api/session never touches Tesla, so checking eagerly is free.
        delay = Math.min(delay * 2, 5000);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [demo, auth.checked]);

  // Poll Tesla media state on a self-scheduling loop. setInterval would stack
  // requests whenever a call outran the interval, and those replies land out of
  // order — an older elapsed value overwriting a newer one drags the position
  // backwards. Scheduling the next poll only after the last one settles makes
  // overlap impossible.
  //
  // A self-scheduling loop has one weakness setInterval doesn't: if a pending
  // timer is ever lost, nothing restarts it. So it is supervised — a watchdog
  // re-kicks a stalled loop, and returning to the page polls immediately
  // (the cabin browser freezes background pages, and the position is stale
  // by the time the driver looks back anyway).
  useEffect(() => {
    if (demo) return undefined;
    if (!auth.authenticated) return undefined;
    let cancelled = false;
    let timer = 0;
    let inFlightSince = 0;
    let lastSettledAt = Date.now();

    function nextDelay() {
      // Asleep or unreachable: back right off. Paused is different — someone is
      // sitting there and will hit play, so keep that responsive.
      if (serverRetryRef.current) return serverRetryRef.current;
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

    function schedule(delay) {
      clearTimeout(timer);
      if (!cancelled) timer = setTimeout(poll, delay);
    }

    async function poll() {
      if (cancelled || inFlightSince) return;
      inFlightSince = Date.now();
      clearTimeout(timer);

      const startedAt = Date.now();
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let keepPolling = true;

      try {
        const res = await fetch('/api/media_state', { signal: controller.signal });

        // Only our own server sends 401, and only when the session is really
        // gone: drop back to the PIN gate.
        if (res.status === 401) {
          keepPolling = false;
          if (!cancelled) {
            setAuth((a) => ({ ...a, checked: true, authenticated: false, configured: true }));
          }
          return;
        }

        // A 503 is only "login not configured" when our server says so in its
        // JSON. Render's proxy sends bare 502/503/504 pages while the service
        // wakes or redeploys; treating those as unconfigured stranded the app
        // on a dead-end screen until reload.
        if (res.status >= 500) {
          const body = await res.json().catch(() => null);
          if (res.status === 503 && body && body.error === 'auth_not_configured') {
            keepPolling = false;
            if (!cancelled) {
              setAuth((a) => ({ ...a, checked: true, authenticated: false, configured: false }));
            }
            return;
          }
          throw Object.assign(new Error(`server ${res.status}`), { serverDown: true });
        }

        const data = await res.json();
        serverRetryRef.current = 0;
        if (!cancelled) applyMediaPayload(data, Date.now() - startedAt);
      } catch (err) {
        if (!cancelled) {
          lastPollOkRef.current = false;
          const vehicleSlow = err.name === 'AbortError';
          setStatus({
            ok: false,
            message: vehicleSlow
              ? 'Vehicle slow to respond…'
              : err.serverDown
                ? 'Server waking up…'
                : 'Reconnecting…',
            error: 'network_error',
          });
          // A hiccup between us and our server says nothing about the car:
          // the song is still playing, so keep the lyric clock running from
          // the last good reading instead of freezing it. The next good poll
          // corrects any drift. A slow Tesla response is different — the car
          // may be asleep, so keep the long backoff there to avoid billed calls.
          if (vehicleSlow) {
            serverRetryRef.current = 0;
          } else {
            serverRetryRef.current = serverRetryRef.current
              ? Math.min(serverRetryRef.current * 2, SERVER_RETRY_MAX_MS)
              : SERVER_RETRY_MS;
          }
        }
      } finally {
        clearTimeout(abortTimer);
        inFlightSince = 0;
        lastSettledAt = Date.now();
        if (keepPolling) schedule(nextDelay());
      }
    }

    // Supervisor. A healthy loop settles at least every ERROR_POLL_MS; well
    // past that, the pending timer was lost. A request stuck past its own
    // abort deadline is treated the same way.
    const watchdog = setInterval(() => {
      if (cancelled) return;
      const now = Date.now();
      if (inFlightSince && now - inFlightSince > REQUEST_TIMEOUT_MS + 5000) {
        inFlightSince = 0;
      }
      if (!inFlightSince && now - lastSettledAt > ERROR_POLL_MS + 10000) poll();
    }, 10000);

    function onReturn() {
      if (document.visibilityState === 'visible') poll();
    }
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
    };
  }, [applyMediaPayload, demo, auth.authenticated]);

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
            if (!endedRef.current && !handoverExpiredRef.current) {
              endedRef.current = true;
              setAwaitingNext(true);
            }
          }
        }
        // Re-render only when the position has moved a step, or jumped back
        // (seek, new track, demo loop) — not on every animation frame.
        const last = lastPushedRef.current;
        if (next < last || next - last >= POSITION_STEP_MS) {
          lastPushedRef.current = next;
          setCurrentPositionMs(next);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [demo]);

  // Safety net: if the next track never shows up, fall back to what we have
  // rather than sitting on the handover indefinitely.
  useEffect(() => {
    if (!awaitingNext) return undefined;
    const t = setTimeout(() => {
      handoverExpiredRef.current = true;
      endedRef.current = false;
      setAwaitingNext(false);
    }, AWAITING_MAX_MS);
    return () => clearTimeout(t);
  }, [awaitingNext]);

  // Fetch lyrics when the track changes.
  //
  // Depends on trackId (a string), NOT the media object. Every poll calls
  // setMedia with a freshly built object, so depending on `media` re-ran this
  // effect each poll: the cleanup flipped `cancelled` and discarded the
  // in-flight response, while the track key had already been claimed, so
  // nothing ever refetched. Any lyrics request slower than the poll interval
  // could never land and the UI sat on "Fetching lyrics…" until a reload.
  useEffect(() => {
    if (demo) return undefined;
    const m = mediaRef.current;
    if (!trackId || trackId === '|') return undefined;
    if (!m?.title || !m?.artist) {
      setLyrics({ lines: [], plainLyrics: null, ok: false });
      setLyricsStatus('Waiting for title & artist…');
      return undefined;
    }

    let cancelled = false;
    let retryTimer = 0;
    setLyricsStatus('Fetching lyrics…');
    setLyrics({ lines: [], plainLyrics: null, ok: false });

    const durationSec =
      m.durationMs > 0 ? Math.round(m.durationMs / 1000) : undefined;
    const qs = new URLSearchParams({ title: m.title, artist: m.artist });
    if (durationSec) qs.set('duration', String(durationSec));

    (async function attempt(tries = 1) {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), LYRICS_TIMEOUT_MS);
      try {
        const res = await fetch(`/api/lyrics?${qs.toString()}`, {
          signal: controller.signal,
        });
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
        } else if (data.retryable && tries <= LYRICS_RETRY_DELAYS_MS.length) {
          // The server reached LRCLIB but it was down. Previously this landed
          // in the branch below and was treated as final, so one 502 cost the
          // whole track.
          setLyricsStatus(data.message || 'Lyrics service is busy — retrying…');
          retryTimer = setTimeout(
            () => attempt(tries + 1),
            LYRICS_RETRY_DELAYS_MS[tries - 1]
          );
        } else {
          setLyrics({ lines: [], plainLyrics: null, ok: false });
          setLyricsStatus(
            data.retryable ? 'Lyrics service unavailable' : data.message || 'No lyrics found'
          );
        }
      } catch (err) {
        if (cancelled) return;
        if (tries <= LYRICS_RETRY_DELAYS_MS.length) {
          setLyricsStatus('Retrying lyrics…');
          retryTimer = setTimeout(
            () => attempt(tries + 1),
            LYRICS_RETRY_DELAYS_MS[tries - 1]
          );
        } else {
          setLyrics({ lines: [], plainLyrics: null, ok: false });
          setLyricsStatus(
            err.name === 'AbortError'
              ? 'Lyrics timed out'
              : `Lyrics error: ${err.message}`
          );
        }
      } finally {
        clearTimeout(abortTimer);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [trackId, demo]);

  const hasTrack = Boolean(media?.title);
  const trackBg = trackBackground(media);
  const checking = !demo && !auth.checked;
  const gated = !demo && auth.checked && !auth.authenticated;

  return (
    <div
      className="teslyr-stage relative flex h-full w-full flex-col text-white transition-[background] duration-700 ease-out"
      style={trackBg ? { background: trackBg } : undefined}
    >
      <div className="teslyr-grid pointer-events-none absolute inset-0" aria-hidden />

      {checking ? (
        <div className="relative flex h-full items-center justify-center">
          <p className="text-lg text-teslyr-mute">
            {status.error === 'network_error' ? status.message : 'Connecting…'}
          </p>
        </div>
      ) : gated ? (
        <OwnerGate
          configured={auth.configured}
          usernameRequired={auth.usernameRequired}
          onAuthenticated={() =>
            setAuth((a) => ({
              ...a,
              checked: true,
              configured: true,
              authenticated: true,
            }))
          }
        />
      ) : (
        <>
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
        </>
      )}
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
