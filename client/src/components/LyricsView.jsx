import React, { useEffect, useMemo, useRef } from 'react';

/**
 * Find the active lyric line index for currentPositionMs.
 * Active = last line whose timeMs <= position.
 */
function findActiveIndex(lines, currentPositionMs) {
  if (!lines?.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= currentPositionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function BrandHero({ message }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center px-8 text-center">
      <div
        className="pointer-events-none absolute inset-0 animate-brandPulse"
        aria-hidden
        style={{
          background:
            'radial-gradient(circle at 50% 42%, rgba(225, 6, 0, 0.2), transparent 42%)',
        }}
      />
      <p className="relative font-display text-6xl font-extrabold tracking-tight text-teslyr-crimson sm:text-7xl">
        Teslyr
      </p>
      <p className="relative mt-4 max-w-md text-lg font-medium text-teslyr-soft sm:text-xl">
        Synced lyrics for the road ahead.
      </p>
      <p className="relative mt-6 text-sm uppercase tracking-[0.22em] text-teslyr-mute">
        {message || 'Waiting for now playing'}
      </p>
    </div>
  );
}

export default function LyricsView({
  lines = [],
  plainLyrics = null,
  currentPositionMs = 0,
  statusMessage = '',
  showBrandHero = false,
}) {
  const containerRef = useRef(null);
  const activeIndex = useMemo(
    () => findActiveIndex(lines, currentPositionMs),
    [lines, currentPositionMs]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || activeIndex < 0) return;

    const activeEl = el.querySelector(`[data-line="${activeIndex}"]`);
    if (!activeEl) return;

    const containerHeight = el.parentElement?.clientHeight || el.clientHeight;
    const lineTop = activeEl.offsetTop;
    const lineHeight = activeEl.offsetHeight;
    const target = lineTop - containerHeight / 2 + lineHeight / 2;

    el.style.transform = `translateY(${-Math.max(0, target)}px)`;
  }, [activeIndex, lines]);

  if (!lines.length) {
    if (showBrandHero && !plainLyrics) {
      return <BrandHero message={statusMessage} />;
    }

    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <div className="animate-riseIn">
          {plainLyrics ? (
            <pre className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap text-left text-xl leading-relaxed text-teslyr-soft">
              {plainLyrics}
            </pre>
          ) : (
            <p className="text-xl text-teslyr-mute">
              {statusMessage || 'No synced lyrics'}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-[#050505] via-[#050505]/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24 bg-gradient-to-t from-[#050505] via-[#050505]/80 to-transparent" />

      <div
        ref={containerRef}
        className="px-6 py-[38vh] transition-transform duration-500 ease-out will-change-transform sm:px-10"
      >
        {lines.map((line, i) => {
          const distance = Math.abs(i - activeIndex);
          const active = distance === 0;
          const near = distance === 1;
          const far = distance > 3;

          let className =
            'lyric-line my-3 text-center font-medium leading-snug text-teslyr-mute';
          if (active) {
            className =
              'lyric-line lyric-line-active my-5 scale-105 text-center font-display text-4xl font-bold leading-snug text-teslyr-ember sm:text-5xl';
          } else if (near) {
            className =
              'lyric-line my-3.5 scale-100 text-center text-2xl font-semibold leading-snug text-teslyr-soft sm:text-3xl';
          } else if (far) {
            className =
              'lyric-line my-3 text-center text-lg leading-snug text-white/25 sm:text-xl';
          } else {
            className =
              'lyric-line my-3 text-center text-xl leading-snug text-teslyr-mute sm:text-2xl';
          }

          return (
            <p
              key={`${line.timeMs}-${i}`}
              data-line={i}
              className={className}
              style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}
            >
              {line.text || '♪'}
            </p>
          );
        })}
      </div>
    </div>
  );
}
