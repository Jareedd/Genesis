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
  const artist = media?.artist || '—';
  const album = media?.album || '';
  const durationMs = media?.durationMs || 0;
  const playback = media?.playbackStatus || status?.message || '';

  const progress =
    durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  return (
    <header className="shrink-0 border-b border-white/10 bg-black px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {title}
          </p>
          <p className="mt-1 truncate text-lg text-gray-300">{artist}</p>
          {album ? (
            <p className="mt-0.5 truncate text-sm text-gray-500">{album}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-sm text-gray-400">
          <div
            className={
              status?.ok
                ? 'text-emerald-400'
                : 'text-amber-400'
            }
          >
            {playback}
          </div>
          {!status?.ok && status?.error ? (
            <div className="mt-1 max-w-[14rem] text-xs text-gray-500">
              {status.message}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3 text-xs text-gray-400">
        <span className="w-10 tabular-nums">{formatTime(positionMs)}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-white/70 transition-[width] duration-200 ease-linear"
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
