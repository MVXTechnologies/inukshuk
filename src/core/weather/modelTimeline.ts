import { floorToStep, type WeatherTimeline } from '@core/geo/weatherTimeline';
import { weatherModelById, type WeatherModelId } from './weatherModels';

/**
 * Per-model timeline logic (weather UX M2): turns a model's TIME dimension —
 * or, offline, its known cadence — into the explicit `framesMs[]` list the
 * scrubber consumes. Explicit lists are the load-bearing shape change:
 * GDPS's 1 h → 3 h cadence change at +84 h means uneven steps are real data,
 * so nothing here may assume a constant step.
 */

/**
 * Hard cap on frames a model timeline may carry. GDPS's full 10-day window
 * is ~133 entries (85 hourly + 52 three-hourly + the seam), well under this;
 * the cap only guards against junk capabilities documents.
 */
export const MAX_MODEL_TIMELINE_FRAMES = 168;

const HOUR_MS = 3_600_000;

/**
 * The zero-network timeline guess for a forecast model: hourly UTC steps from
 * the current hour, switching to the model's post-change cadence (GDPS: 3 h,
 * aligned to the UTC 3-hour grid) after `cadenceChangeHours`. Model steps sit
 * on clean UTC grids, so the guess names real frames; failures upstream keep
 * the scrubber alive on it with zero network.
 */
export function defaultModelTimeline(modelId: WeatherModelId, nowMs: number): WeatherTimeline {
  const model = weatherModelById(modelId);
  const start = floorToStep(nowMs, HOUR_MS);
  const framesMs: number[] = [];
  const hourlyHours = Math.min(model.cadenceChangeHours ?? model.horizonHours, model.horizonHours);
  for (let h = 0; h <= hourlyHours; h++) framesMs.push(start + h * HOUR_MS);
  if (model.cadenceChangeHours !== null && model.stepHoursAfterChange !== null) {
    const stepMs = model.stepHoursAfterChange * HOUR_MS;
    const end = start + model.horizonHours * HOUR_MS;
    // Align the coarse tail to the UTC step grid (real GDPS frames do).
    for (let t = floorToStep(start + hourlyHours * HOUR_MS, stepMs) + stepMs; t <= end; t += stepMs)
      framesMs.push(t);
  }
  return {
    kind: 'forecast',
    framesMs: framesMs.slice(0, MAX_MODEL_TIMELINE_FRAMES),
    fromCapabilities: false,
  };
}

/**
 * The real timeline from an explicit TIME list (see `parseTimeDimensionList`).
 * Forecast semantics match M1's `timelineFromDimension`: hours the run already
 * lived through are dropped (the frame covering "now" is kept), unless that
 * would empty the window — a stale run keeps what the server offers. `past`
 * timelines (radar reached through the same code path) keep their full
 * window. Null on degenerate lists — callers stay on the clock guess.
 */
export function timelineFromTimeList(
  timesMs: readonly number[],
  kind: WeatherTimeline['kind'],
  nowMs: number,
): WeatherTimeline | null {
  if (timesMs.length < 2) return null;
  let startIdx = 0;
  if (kind === 'forecast') {
    // Last frame at or before now — the frame currently in effect.
    let atOrBefore = -1;
    for (let i = 0; i < timesMs.length; i++) {
      const t = timesMs[i];
      if (t !== undefined && t <= nowMs) atOrBefore = i;
    }
    if (atOrBefore >= 0 && timesMs.length - atOrBefore >= 2) startIdx = atOrBefore;
  }
  const framesMs = timesMs.slice(startIdx, startIdx + MAX_MODEL_TIMELINE_FRAMES);
  if (framesMs.length < 2) return null;
  return { kind, framesMs, fromCapabilities: true };
}

/**
 * Time-proportional x-position of frame `idx` across a track of `innerWidth`
 * px. Linear in TIME, not index — this is what makes GDPS's 3-hourly tail
 * visibly wider-spaced than its hourly head on the scrubber.
 */
export function frameX(framesMs: readonly number[], idx: number, innerWidth: number): number {
  const first = framesMs[0];
  const last = framesMs[framesMs.length - 1];
  if (first === undefined || last === undefined || last <= first) return 0;
  const t = framesMs[Math.max(0, Math.min(Math.round(idx), framesMs.length - 1))];
  if (t === undefined) return 0;
  return ((t - first) / (last - first)) * innerWidth;
}

/** The epoch-ms a track ratio (0..1) points at, linear in time. */
export function msForTrackRatio(framesMs: readonly number[], ratio: number): number {
  const first = framesMs[0];
  const last = framesMs[framesMs.length - 1];
  if (first === undefined || last === undefined) return 0;
  const clamped = Math.max(0, Math.min(ratio, 1));
  return first + clamped * (last - first);
}

/**
 * Thin a list of ascending tick x-positions so neighbours keep at least
 * `minGapPx` between them (the first tick always survives). Returns indices
 * into `xs`. Long dense timelines (GDPS's 85 hourly frames) stay readable
 * instead of smearing into a bar.
 */
export function spacedIndices(xs: readonly number[], minGapPx: number): number[] {
  const kept: number[] = [];
  let lastX = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x === undefined) continue;
    if (x - lastX >= minGapPx) {
      kept.push(i);
      lastX = x;
    }
  }
  return kept;
}

/** Comparison-table rows: 3-hourly UTC steps out to +48 h (17 columns). */
export const COMPARE_STEP_MS = 3 * HOUR_MS;
export const COMPARE_HORIZON_MS = 48 * HOUR_MS;

/**
 * The comparison table's valid times: 3-hourly UTC-aligned steps from the
 * step covering "now" out to +48 h. 3-hourly is the coarsest common cadence
 * across HRDPS/RDPS/GDPS inside 48 h, so every model answers every column.
 */
export function compareTimesMs(nowMs: number): number[] {
  const start = floorToStep(nowMs, COMPARE_STEP_MS);
  const out: number[] = [];
  for (let t = start; t <= start + COMPARE_HORIZON_MS; t += COMPARE_STEP_MS) out.push(t);
  return out;
}

/**
 * Request pacing for the table's GetFeatureInfo burst (GeoMet usage policy,
 * ~1 req/s sustained): the first `burst` requests fire immediately, the rest
 * queue at `intervalMs` apart — a token bucket flattened into per-request
 * start delays.
 */
export function burstDelays(count: number, burst: number, intervalMs: number): number[] {
  const delays: number[] = [];
  for (let i = 0; i < count; i++) delays.push(i < burst ? 0 : (i - burst + 1) * intervalMs);
  return delays;
}

/**
 * Cache key for one comparison cell. The point is quantized to ~100 m so a
 * re-opened table near the same spot reuses its warm cache.
 */
export function compareCellKey(wmsLayer: string, timeMs: number, lat: number, lng: number): string {
  return `${wmsLayer}|${timeMs}|${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/**
 * "run 6 h ago" chrome from a model's reference time. Null for junk or
 * future timestamps (clock skew) — the header simply omits the line.
 */
export function runAgeLabel(referenceIso: string | null, nowMs: number): string | null {
  if (referenceIso === null) return null;
  const refMs = Date.parse(referenceIso);
  if (!Number.isFinite(refMs) || refMs > nowMs) return null;
  const ageMin = Math.round((nowMs - refMs) / 60_000);
  if (ageMin < 60) return `run ${Math.max(ageMin, 1)} min ago`;
  const ageH = Math.round(ageMin / 60);
  if (ageH < 48) return `run ${ageH} h ago`;
  return `run ${Math.round(ageH / 24)} d ago`;
}
