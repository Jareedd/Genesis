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

export default function LyricsView({
  lines = [],
  plainLyrics = null,
  currentPositionMs = 0,
  statusMessage = '',
}) {
  const containerRef = useRef(null);
  const activeIndex = useMemo(
    () => findActiveIndex(lines, currentPositionMs),
    [lines, currentPositionMs]
  );

  // Smooth vertical scroll so the active line stays near vertical center
  useEffect(() => {
    const el = containerRef.current;
    if (!el || activeIndex < 0) return;

    const activeEl = el.querySelector(`[data-line="${activeIndex}"]`);
    if (!activeEl) return;

    const containerHeight = el.clientHeight;
    const lineTop = activeEl.offsetTop;
    const lineHeight = activeEl.offsetHeight;
    const target = lineTop - containerHeight / 2 + lineHeight / 2;

    el.style.transform = `translateY(${-Math.max(0, target)}px)`;
  }, [activeIndex, lines]);

  if (!lines.length) {
    return (
      <div className="flex h-full items-center justify-center bg-black px-8 text-center">
        <div>
          {plainLyrics ? (
            <pre className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap text-left text-xl leading-relaxed text-gray-300">
              {plainLyrics}
            </pre>
          ) : (
            <p className="text-xl text-gray-500">
              {statusMessage || 'No synced lyrics'}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden bg-black">
      {/* Top/bottom soft fade without heavy blur (Tesla browser friendly) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-black to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-16 bg-gradient-to-t from-black to-transparent" />

      <div
        ref={containerRef}
        className="px-6 py-[40vh] transition-transform duration-500 ease-out will-change-transform"
      >
        {lines.map((line, i) => {
          const active = i === activeIndex;
          const near = Math.abs(i - activeIndex) <= 1;
          return (
            <p
              key={`${line.timeMs}-${i}`}
              data-line={i}
              className={
                active
                  ? 'my-4 text-center text-4xl font-bold leading-snug text-white'
                  : near
                    ? 'my-3 text-center text-2xl font-medium leading-snug text-gray-400'
                    : 'my-3 text-center text-xl leading-snug text-gray-500'
              }
            >
              {line.text}
            </p>
          );
        })}
      </div>
    </div>
  );
}
