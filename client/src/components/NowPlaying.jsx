import React from 'react';

function formatTime(ms) {
  if (!ms || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function NowPlaying({ media, status, positionMs }) {
  const title = media?.title || 'Nothing playing';
  const artist = media?.artist || 'Waiting for media';
  const album = media?.album || '';
  const durationMs = media?.durationMs || 0;
  const playback = media?.playbackStatus || status?.message || '';
  const connected = Boolean(status?.ok);

  const progress =
    durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  return (
    <header className="relative z-20 shrink-0 px-5 pb-4 pt-4 sm:px-8 sm:pt-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-teslyr-crimson sm:text-3xl">
            Teslyr
          </h1>
          <span className="hidden font-sans text-[0.7rem] uppercase tracking-[0.28em] text-teslyr-mute sm:inline">
            live lyrics
          </span>
        </div>

        <div className="flex items-center gap-2.5 text-sm text-teslyr-mute">
          <span
            className={
              connected
                ? 'inline-block h-2.5 w-2.5 animate-pulseDot rounded-full bg-teslyr-live'
                : 'inline-block h-2.5 w-2.5 rounded-full bg-teslyr-crimson'
            }
            aria-hidden
          />
          <span className={connected ? 'text-teslyr-soft' : 'text-teslyr-ember'}>
            {playback}
          </span>
        </div>
      </div>

      <div className="flex items-end justify-between gap-4 border-t border-white/[0.08] pt-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {title}
          </p>
          <p className="mt-1 truncate text-lg font-medium text-teslyr-soft">{artist}</p>
          {album ? (
            <p className="mt-0.5 truncate text-sm text-teslyr-mute">{album}</p>
          ) : null}
        </div>

        {!connected && status?.error ? (
          <div className="max-w-[12rem] shrink-0 text-right text-xs leading-snug text-teslyr-mute">
            {status.message}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center gap-3 text-xs text-teslyr-mute">
        <span className="w-10 tabular-nums">{formatTime(positionMs)}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="progress-fill h-full rounded-full transition-[width] duration-200 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="w-10 text-right tabular-nums">
          {formatTime(durationMs)}
        </span>
      </div>
    </header>
  );
}
