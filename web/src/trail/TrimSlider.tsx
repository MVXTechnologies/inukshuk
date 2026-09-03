import { useCallback, useRef } from 'react';

/**
 * The dual-thumb trim range, ported from
 * `src/features/map/components/TrimRangeSlider.tsx`.
 *
 * Same mechanics: the range is over POINT INDICES (not distance), a press grabs
 * the nearest thumb, and the kept window can never collapse below two points
 * (`start < end` is enforced on every move) — `sliceTrack` would otherwise
 * happily return a one-point track with empty stats.
 *
 * Ported as two stacked native range inputs rather than a hand-rolled pointer
 * handler: a real `<input type="range">` brings keyboard stepping, arrow/Home/
 * End, and screen-reader `aria-valuetext` for free, all of which the app's
 * PanResponder version has to live without.
 */
export function TrimSlider({
  count,
  start,
  end,
  onChange,
}: {
  count: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}) {
  const last = Math.max(0, count - 1);
  const track = useRef<HTMLDivElement>(null);

  const setStart = useCallback((v: number) => onChange(Math.min(v, end - 1), end), [end, onChange]);
  const setEnd = useCallback(
    (v: number) => onChange(start, Math.max(v, start + 1)),
    [start, onChange],
  );

  const pct = (i: number) => (last === 0 ? 0 : (i / last) * 100);

  return (
    <div className="trim-slider" ref={track}>
      <div className="trim-rail" />
      <div className="trim-kept" style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }} />
      <input
        type="range"
        className="trim-range lo"
        min={0}
        max={last}
        step={1}
        value={start}
        aria-label="Trim start"
        aria-valuetext={`Point ${start + 1} of ${count}`}
        onChange={(e) => setStart(Number(e.target.value))}
      />
      <input
        type="range"
        className="trim-range hi"
        min={0}
        max={last}
        step={1}
        value={end}
        aria-label="Trim end"
        aria-valuetext={`Point ${end + 1} of ${count}`}
        onChange={(e) => setEnd(Number(e.target.value))}
      />
    </div>
  );
}
