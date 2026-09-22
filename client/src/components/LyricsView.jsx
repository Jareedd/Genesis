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

  // Spotify-style top/bottom fade via a mask so it reads over any track color.
  const fadeMask =
    'linear-gradient(to bottom, transparent 0%, #000 14%, #000 86%, transparent 100%)';

  return (
    <div className="relative h-full overflow-hidden">
      <div
        ref={containerRef}
        className="px-6 py-[42vh] transition-transform duration-500 ease-out will-change-transform sm:px-12"
        style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
      >
        {lines.map((line, i) => {
          const active = i === activeIndex;
          const sung = activeIndex >= 0 && i < activeIndex;

          let className =
            'lyric-line my-6 max-w-4xl text-left font-display font-extrabold leading-[1.12] tracking-tight text-3xl sm:text-5xl ';
          if (active) {
            className += 'lyric-line-active text-white';
          } else if (sung) {
            className += 'text-white/30';
          } else {
            className += 'text-white/50';
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
