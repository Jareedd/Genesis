import React from 'react';

function formatTime(ms) {
  if (!ms || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function friendlyStatus(status) {
  if (!status) return '';
  const map = {
    missing_token: 'Add Tesla token',
    missing_vehicle_id: 'Set vehicle id',
    vehicle_asleep: 'Vehicle asleep',
    network_error: 'Reconnect…',
  };
  if (status.error && map[status.error]) return map[status.error];
  const msg = status.message || '';
  if (msg.length > 42) return `${msg.slice(0, 40)}…`;
  return msg;
}

export default function NowPlaying({ media, status, positionMs }) {
  const title = media?.title || 'Nothing playing';
  const artist = media?.artist || 'Waiting for media';
  const album = media?.album || '';
  const durationMs = media?.durationMs || 0;
  const connected = Boolean(status?.ok);
  const playback = media?.playbackStatus
    || (connected ? status?.message : friendlyStatus(status))
    || 'Offline';

  const progress =
    durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  return (
    <header className="relative z-20 shrink-0 px-5 pb-4 pt-4 sm:px-8 sm:pt-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
            Teslyr
          </h1>
          <span className="hidden font-sans text-[0.7rem] uppercase tracking-[0.28em] text-white/50 sm:inline">
            live lyrics
          </span>
        </div>

        <div className="flex items-center gap-2.5 text-sm text-white/70">
          <span
            className={
              connected
                ? 'inline-block h-2.5 w-2.5 animate-pulseDot rounded-full bg-teslyr-live'
                : 'inline-block h-2.5 w-2.5 rounded-full bg-white/60'
            }
            aria-hidden
          />
          <span className={connected ? 'text-white/85' : 'text-white/70'}>
            {playback}
          </span>
        </div>
      </div>

      <div className="flex items-end justify-between gap-4 border-t border-white/[0.14] pt-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {title}
          </p>
          <p className="mt-1 truncate text-lg font-medium text-white/80">{artist}</p>
          {album ? (
            <p className="mt-0.5 truncate text-sm text-white/55">{album}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3 text-xs text-white/70">
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
