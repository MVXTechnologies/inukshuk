import { formatWmsTime, type WeatherTimelineKind, type WmsTimeDimension } from './weatherLayers';

/**
 * Weather time-scrubber logic (weather UX M1): builds the frame timeline a
 * layer can be scrubbed across, from either the layer's live GetCapabilities
 * TIME dimension or — before it arrives / when it never does (offline) — a
 * clock-based guess that keeps the scrubber usable with zero network.
 *
 * The seam the scrubber sits on (verified live against GeoMet, 2026-08-09):
 * - radar layers (RADAR_1KM_*) carry ~3 h of PAST frames at PT6M steps —
 *   their timeline ends at the latest observation and scrubs backwards;
 * - HRDPS model layers carry a ~48 h FORECAST horizon at PT1H steps from the
 *   latest run — their timeline starts at "now" and scrubs forwards.
 *
 * M2 seam: model-compare will swap which WMS layer the frames apply to; the
 * timeline shape itself (frames + kind) is model-agnostic on purpose.
 */

/** Radar composites publish every 6 minutes. */
export const RADAR_STEP_MS = 6 * 60_000;
/** HRDPS model fields are hourly. */
export const FORECAST_STEP_MS = 3_600_000;
/** Radar keeps roughly the last 3 h of frames. */
export const RADAR_WINDOW_MS = 3 * 3_600_000;
/** HRDPS forecast horizon (~48 h from the run). */
export const FORECAST_HORIZON_MS = 48 * 3_600_000;
/**
 * Clock-guessed radar timelines stop this far behind "now": radar frames
 * publish with a few minutes of latency, and a guessed TIME that isn't
 * published yet would render as a blank drape.
 */
export const RADAR_PUBLISH_LAG_MS = 2 * RADAR_STEP_MS;
/**
 * Hard cap on timeline length — guards against a junk capabilities document
 * (e.g. a tiny step over a huge window) exploding the tick list. 49 hourly
 * forecast frames and 31 radar frames both fit comfortably.
 */
export const MAX_TIMELINE_FRAMES = 96;
/**
 * Minimum interval between WMS TIME updates while scrubbing. Each update
 * re-fetches the visible tile set, so the drag itself must not emit per-pixel
 * — 300 ms keeps scrubbing smooth while staying inside GeoMet's usage policy.
 */
export const SCRUB_THROTTLE_MS = 300;

export interface WeatherTimeline {
  kind: WeatherTimelineKind;
  /** Frame valid-times, epoch ms, ascending. Always at least 2 entries. */
  framesMs: readonly number[];
  /** True when built from a live GetCapabilities dimension, false for the clock guess. */
  fromCapabilities: boolean;
}

/** Largest multiple of `stepMs` at or below `ms` (steps anchored at the epoch). */
export function floorToStep(ms: number, stepMs: number): number {
  return Math.floor(ms / stepMs) * stepMs;
}

function frameRange(startMs: number, endMs: number, stepMs: number): number[] {
  const frames: number[] = [];
  const count = Math.min(Math.floor((endMs - startMs) / stepMs) + 1, MAX_TIMELINE_FRAMES);
  for (let i = 0; i < count; i++) frames.push(startMs + i * stepMs);
  return frames;
}

/**
 * The zero-network timeline guess: keeps the scrubber alive before (or
 * without) GetCapabilities. Radar and HRDPS frames both sit on clean UTC step
 * grids, so a clock-aligned guess names real frames — except at the radar
 * window's fresh end, which {@link wmsTimeParam} hands back to the server
 * default instead of guessing.
 */
export function defaultTimeline(kind: WeatherTimelineKind, nowMs: number): WeatherTimeline {
  if (kind === 'past') {
    const end = floorToStep(nowMs - RADAR_PUBLISH_LAG_MS, RADAR_STEP_MS);
    return {
      kind,
      framesMs: frameRange(end - RADAR_WINDOW_MS, end, RADAR_STEP_MS),
      fromCapabilities: false,
    };
  }
  const start = floorToStep(nowMs, FORECAST_STEP_MS);
  return {
    kind,
    framesMs: frameRange(start, start + FORECAST_HORIZON_MS, FORECAST_STEP_MS),
    fromCapabilities: false,
  };
}

/**
 * The real timeline from a layer's TIME dimension. Radar keeps the full past
 * window; forecast clamps the start to "now" (the hours a model run already
 * lived through aren't forecast anymore — Windy does the same), unless that
 * would empty the window (a stale run: keep what the server offers). Null on
 * degenerate dimensions — callers stay on the clock guess.
 */
export function timelineFromDimension(
  dim: WmsTimeDimension,
  kind: WeatherTimelineKind,
  nowMs: number,
): WeatherTimeline | null {
  if (dim.stepMs <= 0 || dim.endMs < dim.startMs) return null;
  let startMs = dim.startMs;
  if (kind === 'forecast') {
    const nowFloor = Math.max(floorToStep(nowMs, dim.stepMs), dim.startMs);
    if (nowFloor <= dim.endMs) startMs = nowFloor;
  }
  const framesMs = frameRange(startMs, dim.endMs, dim.stepMs);
  if (framesMs.length < 2) return null;
  return { kind, framesMs, fromCapabilities: true };
}

/** Index of the frame nearest to `ms` (ties resolve to the earlier frame). */
export function nearestFrameIndex(timeline: WeatherTimeline, ms: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < timeline.framesMs.length; i++) {
    const frame = timeline.framesMs[i];
    if (frame === undefined) continue;
    const dist = Math.abs(frame - ms);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

export function clampFrameIndex(timeline: WeatherTimeline, idx: number): number {
  return Math.max(0, Math.min(Math.round(idx), timeline.framesMs.length - 1));
}

/**
 * The WMS TIME parameter for a selected frame — undefined means "no TIME",
 * i.e. the server's default latest frame. That's the honest choice for the
 * newest tick of a clock-GUESSED radar timeline: the guess may name a frame
 * radar hasn't published yet (blank tiles), while the server default always
 * exists. Capabilities-backed timelines always pin the explicit frame.
 */
export function wmsTimeParam(timeline: WeatherTimeline, idx: number): string | undefined {
  const clamped = clampFrameIndex(timeline, idx);
  if (
    !timeline.fromCapabilities &&
    timeline.kind === 'past' &&
    clamped === timeline.framesMs.length - 1
  ) {
    return undefined;
  }
  const ms = timeline.framesMs[clamped];
  return ms === undefined ? undefined : formatWmsTime(ms);
}

/**
 * Trailing-throttle gate for scrub-driven TIME updates: `emit` when the
 * minimum interval has passed since the last emit, else `waitMs` says how
 * long the trailing edge must wait. Pure — the caller owns the clock and the
 * timer (see `useWeatherTimeline`).
 */
export function throttleGate(
  lastEmitMs: number | null,
  nowMs: number,
  minIntervalMs: number,
): { emit: boolean; waitMs: number } {
  if (lastEmitMs === null || nowMs - lastEmitMs >= minIntervalMs) return { emit: true, waitMs: 0 };
  return { emit: false, waitMs: minIntervalMs - (nowMs - lastEmitMs) };
}

/** English weekday abbreviations for the scrubber readout and day ticks. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Scrubber readout for a frame, in device-local time: "Sat 14:00". */
export function formatTimelineLabel(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAY_LABELS[d.getDay()] ?? ''} ${hh}:${mm}`;
}

export interface DaySegment {
  /** First frame index of this local calendar day. */
  startIdx: number;
  /** Last frame index of this local calendar day (inclusive). */
  endIdx: number;
  /** Weekday label for the day tick, e.g. "Sun". */
  label: string;
}

/**
 * Groups a timeline's frames into local calendar days — the scrubber draws a
 * taller tick + weekday label at each day boundary (every segment after the
 * first).
 */
export function daySegments(framesMs: readonly number[]): DaySegment[] {
  const segments: DaySegment[] = [];
  let currentKey: string | null = null;
  for (let i = 0; i < framesMs.length; i++) {
    const ms = framesMs[i];
    if (ms === undefined) continue;
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = segments[segments.length - 1];
    if (key === currentKey && last !== undefined) {
      last.endIdx = i;
    } else {
      currentKey = key;
      segments.push({ startIdx: i, endIdx: i, label: WEEKDAY_LABELS[d.getDay()] ?? '' });
    }
  }
  return segments;
}

/** True when a frame sits on a whole local hour — the scrubber's mid-height ticks. */
export function isHourMark(epochMs: number): boolean {
  return new Date(epochMs).getMinutes() === 0;
}
