import { useMemo } from 'react';

import {
  daySegments,
  formatTimelineLabel,
  isHourMark,
  type WeatherTimeline,
} from '@core/geo/weatherTimeline';

import { useNow } from '@/lib/useNow';
import { IconPause, IconPlay, IconSpinner } from '@/ui/Icons';

/**
 * The time scrubber.
 *
 * Every bit of what it draws comes from `@core/geo/weatherTimeline`:
 * `daySegments` groups the frames into local calendar days for the tall day
 * ticks and their weekday labels, `isHourMark` picks the mid-height ticks, and
 * `formatTimelineLabel` writes the readout. The frames themselves are either
 * GeoMet's real TIME dimension or the clock guess — and the strip says which,
 * because "is this a real forecast horizon or a guess" is exactly the thing you
 * want to know when a drape looks wrong.
 */
export function TimeScrubber({
  timeline,
  frameIndex,
  onFrame,
  playing,
  onTogglePlay,
  referenceTimeMs,
  loading,
}: {
  timeline: WeatherTimeline;
  frameIndex: number;
  onFrame: (idx: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  referenceTimeMs: number | null;
  loading: boolean;
}) {
  const frames = timeline.framesMs;
  const days = useMemo(() => daySegments(frames), [frames]);
  const current = frames[frameIndex];

  // Minute-stepped so the age stays truthful on a tab left open, and so the
  // memo below is a pure function of its inputs rather than of the wall clock.
  const nowMs = useNow(60_000);
  const runAge = useMemo(() => {
    if (referenceTimeMs === null) return null;
    const hours = Math.round((nowMs - referenceTimeMs) / 3_600_000);
    if (hours < 1) return 'run just now';
    return `run ${hours} h ago`;
  }, [referenceTimeMs, nowMs]);

  return (
    <div className="scrubber panel">
      <button
        type="button"
        className="play"
        onClick={onTogglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <IconPause /> : <IconPlay />}
      </button>

      <div className="scrub-body">
        <div className="scrub-head">
          <span className="scrub-now num">
            {current === undefined ? '—' : formatTimelineLabel(current)}
          </span>
          <span className="scrub-src">
            {timeline.fromCapabilities ? 'GeoMet' : 'clock guess'}
            {runAge === null ? '' : ` · ${runAge}`}
            {timeline.kind === 'past' ? ' · observed' : ' · forecast'}
          </span>
          <span className="spacer" />
          {loading ? (
            <span className="scrub-src" title="Fetching frame">
              <IconSpinner size={11} className="spin" />
            </span>
          ) : null}
          <span className="scrub-src num">
            {frameIndex + 1}/{frames.length}
          </span>
        </div>

        <div className="scrub-track">
          <div className="ticks" aria-hidden="true">
            {frames.map((ms, i) => {
              const isDayStart = days.some((d) => d.startIdx === i);
              const cls = isDayStart ? 'day' : isHourMark(ms) ? 'hour' : 'plain';
              return <span key={ms} className={`tick ${cls}`} />;
            })}
          </div>
          <input
            className="range"
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            step={1}
            value={frameIndex}
            onChange={(e) => onFrame(Number(e.currentTarget.value))}
            aria-label="Forecast time"
          />
        </div>

        <div className="day-labels" aria-hidden="true">
          {days.slice(1).map((d) => (
            <span
              key={d.startIdx}
              className="day-label"
              style={{ left: `${((d.startIdx + 0.5) / Math.max(1, frames.length)) * 100}%` }}
            >
              {d.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
