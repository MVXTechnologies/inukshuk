/**
 * Water level on the map and in the card's graph (#764): from a station's
 * observed series (its live gauge), its predicted curve and its predicted
 * highs and lows, the reading "now" (live, old, or predicted), its trend,
 * the next high or low, the map label's text at each zoom tier, the graph's
 * series, and which stations on screen are worth a request.
 *
 * Owner rules (mockup #764, approved 2026-10-16):
 * - the label reads "now, trend · next high or low": `1.36 m ↗ · H 2.95 m 16:52`
 *   (the arrow is an inline image, our glyphs have none); one line wherever
 *   it fits; from z13 the rate joins and it becomes two short lines;
 * - zoom ladder: nothing below z8; z8–10 live gauges only, one decimal and
 *   the next tide's time (`1.4 m ↗ · H 16:52`); z11+ every station with data;
 * - a reading older than an hour goes pale with its age and loses its arrow,
 *   the next high/low (a prediction) stays; older than 12 h the label shows
 *   the predicted level instead;
 * - at most 12 stations, nearest the centre, refreshed every 10 min.
 *
 * Pure: heights in metres, times epoch ms; the clock (phone time) is injected.
 */
import { formatElevation, toElevationUnit, type Units } from '@core/format';
import type { TideExtreme, TideReading } from '@core/weather/tides';

import { tideSourceAt } from './catalog';
import type { TideStation } from './station';

/** Zoom tiers of the level label (layer min zooms). */
export const LEVEL_ZOOM = { mid: 8, full: 11, rate: 13 } as const;
export type LevelTier = 'mid' | 'full' | 'rate';

export const LEVELS_MAX_STATIONS = 12;
/** Observed series and labels refresh at this rhythm (the info strip's tide rhythm). */
export const LEVELS_REFRESH_MS = 10 * 60_000;
/** A station's predictions are fetched once a day and kept on the device. */
export const PREDICTION_TTL_MS = 24 * 3_600_000;
/** Predictions are fetched from this far back … */
export const PREDICTION_BACK_MS = 12 * 3_600_000;
/** … to this far ahead: a day-old copy still covers the graph's 16 h ahead. */
export const PREDICTION_AHEAD_MS = 48 * 3_600_000;
/** The observed series fetched (the graph shows the last 8 h). */
export const OBSERVED_WINDOW_MS = 12 * 3_600_000;
/** A reading older than this is not "now": pale, with its age. */
export const STALE_AFTER_MS = 60 * 60_000;
/** Older than this, the label shows the predicted level instead. */
export const STALE_TO_PREDICTED_MS = 12 * 3_600_000;
/** Slower than this the water is slack (flat arrow). */
export const SLACK_M_PER_H = 0.05;
/** The trend is fitted over the last 30 minutes of readings. */
export const TREND_WINDOW_MS = 30 * 60_000;
/** The card's graph window. */
export const GRAPH_PAST_MS = 8 * 3_600_000;
export const GRAPH_AHEAD_MS = 16 * 3_600_000;

export type TrendDir = 'up' | 'down' | 'flat';
export type LevelKind = 'live' | 'stale' | 'pred';

export interface TideSeries {
  /** Observed water level above chart datum, time-sorted. */
  observed: readonly TideReading[];
  /** Predicted curve above chart datum, time-sorted (may be empty: highs/lows only). */
  predicted: readonly TideReading[];
  /** Predicted highs and lows, time-sorted. */
  extremes: readonly TideExtreme[];
}

export interface LevelReading {
  kind: LevelKind;
  heightM: number;
  /** When the level was read (observed) or for when it is predicted (now). */
  timeMs: number;
  ageMs: number;
  dir: TrendDir | null;
  rateMPerH: number | null;
  next: TideExtreme | null;
}

/** The label tier at a zoom, or null below z8 (dots only). */
export function levelTier(zoom: number): LevelTier | null {
  if (!Number.isFinite(zoom) || zoom < LEVEL_ZOOM.mid) return null;
  if (zoom < LEVEL_ZOOM.full) return 'mid';
  return zoom < LEVEL_ZOOM.rate ? 'full' : 'rate';
}

function dirOf(rateMPerH: number): TrendDir {
  if (Math.abs(rateMPerH) < SLACK_M_PER_H) return 'flat';
  return rateMPerH > 0 ? 'up' : 'down';
}

/**
 * The trend of the last {@link TREND_WINDOW_MS} of readings (least-squares
 * slope, m/h), or null with fewer than two readings spanning 5 minutes.
 */
export function trendOf(
  readings: readonly TideReading[],
): { dir: TrendDir; rateMPerH: number } | null {
  const last = readings[readings.length - 1];
  if (!last) return null;
  const pts = readings.filter((r) => r.timeMs >= last.timeMs - TREND_WINDOW_MS);
  const first = pts[0];
  if (pts.length < 2 || !first || last.timeMs - first.timeMs < 5 * 60_000) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.timeMs, 0) / n;
  const my = pts.reduce((s, p) => s + p.heightM, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.timeMs - mx) * (p.heightM - my);
    den += (p.timeMs - mx) ** 2;
  }
  if (den === 0) return null;
  const rateMPerH = (num / den) * 3_600_000;
  return { dir: dirOf(rateMPerH), rateMPerH };
}

/** Linear interpolation inside the series; null outside it (never extrapolated). */
export function interpolate(points: readonly TideReading[], t: number): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || t < first.timeMs || t > last.timeMs) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((points[mid]?.timeMs ?? 0) <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (!a || !b) return null;
  if (b.timeMs === a.timeMs) return a.heightM;
  return a.heightM + ((b.heightM - a.heightM) * (t - a.timeMs)) / (b.timeMs - a.timeMs);
}

/**
 * The level between two predicted extremes by the cosine rule (a NOAA
 * secondary station publishes only its highs and lows); null outside them.
 */
export function cosineBetween(extremes: readonly TideExtreme[], t: number): number | null {
  for (let i = 0; i + 1 < extremes.length; i++) {
    const a = extremes[i];
    const b = extremes[i + 1];
    if (!a || !b || t < a.timeMs || t > b.timeMs || b.timeMs === a.timeMs) continue;
    const f = (t - a.timeMs) / (b.timeMs - a.timeMs);
    return a.heightM + ((b.heightM - a.heightM) * (1 - Math.cos(Math.PI * f))) / 2;
  }
  return null;
}

/** The predicted level at `t`: the curve when there is one, else the cosine rule. */
export function predictedAt(series: TideSeries, t: number): number | null {
  return interpolate(series.predicted, t) ?? cosineBetween(series.extremes, t);
}

/**
 * Highs and lows of a predicted curve (when the agency's list is missing):
 * turning points, plateaus counted once.
 */
export function extremesOfCurve(points: readonly TideReading[]): TideExtreme[] {
  const out: TideExtreme[] = [];
  let prevDir = 0;
  let prev = points[0];
  let turn: TideReading | undefined = prev;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (!p || !prev) continue;
    const d = Math.sign(p.heightM - prev.heightM);
    if (d !== 0) {
      if (prevDir !== 0 && d !== prevDir && turn) {
        out.push({
          timeMs: turn.timeMs,
          heightM: turn.heightM,
          kind: prevDir > 0 ? 'high' : 'low',
        });
      }
      prevDir = d;
      turn = p;
    }
    prev = p;
  }
  return out;
}

/**
 * Unlabelled high/low events (CHS `wlp-hilo`) → highs and lows: each event
 * against its neighbour, as `nextHighLow` judges them. Fewer than two: none.
 */
export function classifyHiLo(events: readonly TideReading[]): TideExtreme[] {
  const sorted = [...events].sort((a, b) => a.timeMs - b.timeMs);
  if (sorted.length < 2) return [];
  const out: TideExtreme[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const n = i + 1 < sorted.length ? sorted[i + 1] : sorted[i - 1];
    if (!e || !n) continue;
    out.push({
      timeMs: e.timeMs,
      heightM: e.heightM,
      kind: e.heightM > n.heightM ? 'high' : 'low',
    });
  }
  return out;
}

/** The first high or low after `nowMs`. */
export function nextExtreme(extremes: readonly TideExtreme[], nowMs: number): TideExtreme | null {
  return extremes.find((e) => e.timeMs > nowMs) ?? null;
}

/** The predicted trend at `t` (the curve's slope over ±15 min). */
function predictedTrend(
  series: TideSeries,
  t: number,
): { dir: TrendDir; rateMPerH: number } | null {
  const a = predictedAt(series, t - 15 * 60_000);
  const b = predictedAt(series, t + 15 * 60_000);
  if (a === null || b === null) return null;
  const rateMPerH = (b - a) * 2;
  return { dir: dirOf(rateMPerH), rateMPerH };
}

/** The station's reading now (live, old or predicted), or null when nothing is known. */
export function levelReading(series: TideSeries, nowMs: number): LevelReading | null {
  const last = [...series.observed].reverse().find((r) => r.timeMs <= nowMs + 60_000);
  const next = nextExtreme(series.extremes, nowMs);
  if (last) {
    const ageMs = Math.max(0, nowMs - last.timeMs);
    if (ageMs <= STALE_AFTER_MS) {
      const trend = trendOf(series.observed.filter((r) => r.timeMs <= last.timeMs));
      return {
        kind: 'live',
        heightM: last.heightM,
        timeMs: last.timeMs,
        ageMs,
        dir: trend?.dir ?? null,
        rateMPerH: trend?.rateMPerH ?? null,
        next,
      };
    }
    if (ageMs <= STALE_TO_PREDICTED_MS) {
      return {
        kind: 'stale',
        heightM: last.heightM,
        timeMs: last.timeMs,
        ageMs,
        dir: null,
        rateMPerH: null,
        next,
      };
    }
  }
  const h = predictedAt(series, nowMs);
  if (h === null) return null;
  const trend = predictedTrend(series, nowMs);
  return {
    kind: 'pred',
    heightM: h,
    timeMs: nowMs,
    ageMs: 0,
    dir: trend?.dir ?? null,
    rateMPerH: trend?.rateMPerH ?? null,
    next,
  };
}

/** "2 h" (a reading over an hour old). */
export function ageText(ageMs: number): string {
  const h = Math.floor(ageMs / 3_600_000);
  return h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ageMs / 60_000))} min`;
}

/** "+0.66 m/h" / "−0.12 m/h" in the elevation unit. */
export function rateText(rateMPerH: number, units: Units): string {
  const v = formatElevation(Math.abs(rateMPerH), units, { decimals: 2 });
  return `${rateMPerH < 0 ? '−' : '+'}${v}/h`;
}

/** A label's parts: the value, the arrow (an inline image), and the rest. */
export interface LevelLabel {
  value: string;
  /** The arrow image's direction; 'none' = no arrow (an old reading, or no trend). */
  dir: TrendDir | 'none';
  /** After the arrow; may hold a line break (the z13+ form). */
  rest: string;
}

/** The map label at a tier. `clock` prints the phone's time ("16:52"). */
export function levelLabel(
  r: LevelReading,
  tier: LevelTier,
  units: Units,
  clock: (ms: number) => string,
): LevelLabel {
  const value = formatElevation(r.heightM, units, { decimals: tier === 'mid' ? 1 : 2 });
  const dir = r.kind === 'stale' || r.dir === null ? 'none' : r.dir;
  const age = r.kind === 'stale' ? ` · ${ageText(r.ageMs)}` : '';
  const k = r.next ? (r.next.kind === 'high' ? 'H' : 'L') : '';
  const nextFull = r.next
    ? `${k} ${formatElevation(r.next.heightM, units, { decimals: 2 })} ${clock(r.next.timeMs)}`
    : '';
  if (tier === 'mid') {
    return { value, dir, rest: `${age}${r.next ? ` · ${k} ${clock(r.next.timeMs)}` : ''}` };
  }
  if (tier === 'full') return { value, dir, rest: `${age}${nextFull ? ` · ${nextFull}` : ''}` };
  const rate = r.kind !== 'stale' && r.rateMPerH !== null ? ` ${rateText(r.rateMPerH, units)}` : '';
  return { value, dir, rest: `${age}${rate}${nextFull ? `\n${nextFull}` : ''}` };
}

/** One-line text width at 12 px, roughly (bold Atkinson ≈ 0.6 em a character, the arrow 1 em). */
export function labelWidthPx(l: LevelLabel): number {
  const lines = `${l.value}${l.dir === 'none' ? '' : 'MM'}${l.rest}`.split('\n');
  return Math.max(...lines.map((s) => s.length)) * 7.2;
}

/** Pill images by width (`tide-pill-{lines}-{w}`); the nearest one up is stretched to fit. */
export const PILL_WIDTHS = [48, 64, 80, 104, 128, 152, 184, 216] as const;

export function pillImage(l: LevelLabel): string {
  const lines = l.rest.includes('\n') ? 2 : 1;
  const w = labelWidthPx(l);
  const pick = PILL_WIDTHS.find((p) => p >= w) ?? PILL_WIDTHS[PILL_WIDTHS.length - 1];
  return `tide-pill-${lines}-${pick}`;
}

/** What can be asked of a station's agency: its observed series, its predictions. */
export interface StationFeeds {
  observed: 'coops' | 'kv' | 'chs' | null;
  /** 'coops-hilo': a NOAA secondary station (highs and lows only). */
  predicted: 'coops' | 'coops-hilo' | 'kv' | 'chs' | null;
}

/**
 * The feeds a station has. NOAA: live gauges observe, reference and gauge
 * stations predict a curve, secondary ones only highs and lows. Kartverket:
 * both. CHS: a live gauge observes; gauges and prediction stations predict.
 * SHOM and JMA: none (no free service), so no label and no graph.
 */
export function stationFeeds(s: {
  sourceKey: string | undefined;
  kind: string;
  live?: string;
}): StationFeeds {
  const observed = s.live === 'coops' || s.live === 'kv' || s.live === 'chs' ? s.live : null;
  switch (s.sourceKey) {
    case 'us-coops':
      return {
        observed,
        predicted: s.kind === 'sec' ? 'coops-hilo' : s.kind === 'hist' ? null : 'coops',
      };
    case 'no-kartverket':
      return { observed, predicted: 'kv' };
    case 'ca-chs':
      return { observed, predicted: s.kind === 'gauge' || s.kind === 'ref' ? 'chs' : null };
    default:
      return { observed, predicted: null };
  }
}

/** A station's feeds, from its source in the catalogue. */
export function stationFeedsOf(s: Pick<TideStation, 'source' | 'kind' | 'live'>): StationFeeds {
  return stationFeeds({
    sourceKey: tideSourceAt(s.source)?.key,
    kind: s.kind,
    ...(s.live ? { live: s.live } : {}),
  });
}

/**
 * The stations worth a request at this tier: live gauges only at mid zoom,
 * every station with a feed from z11; nearest the centre first, at most
 * {@link LEVELS_MAX_STATIONS}.
 */
export function pickLevelStations<T extends { lat: number; lng: number; feeds: StationFeeds }>(
  stations: readonly T[],
  center: readonly [number, number],
  tier: LevelTier,
  max = LEVELS_MAX_STATIONS,
): T[] {
  const cos = Math.cos((center[1] * Math.PI) / 180);
  return stations
    .filter((s) =>
      tier === 'mid'
        ? s.feeds.observed !== null
        : s.feeds.observed !== null || s.feeds.predicted !== null,
    )
    .map((s) => ({ s, d: Math.hypot((s.lng - center[0]) * cos, s.lat - center[1]) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.s);
}

/** A label feature's properties, one text per tier (the layers pick theirs by zoom). */
export interface LevelFeatureProps {
  /** Station key. */
  id: string;
  k: LevelKind;
  /** Arrow direction per tier ('none' = no arrow). */
  d: TrendDir | 'none';
  v1: string;
  r1: string;
  p1: string;
  v2: string;
  r2: string;
  p2: string;
  r3: string;
  p3: string;
}

export interface LevelFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: LevelFeatureProps;
}

/** The label features for the stations whose reading is known. */
export function levelFeatures(
  entries: readonly { id: string; lng: number; lat: number; reading: LevelReading | null }[],
  units: Units,
  clock: (ms: number) => string,
): { type: 'FeatureCollection'; features: LevelFeature[] } {
  const features: LevelFeature[] = [];
  for (const e of entries) {
    if (!e.reading) continue;
    const mid = levelLabel(e.reading, 'mid', units, clock);
    const full = levelLabel(e.reading, 'full', units, clock);
    const rate = levelLabel(e.reading, 'rate', units, clock);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
      properties: {
        id: e.id,
        k: e.reading.kind,
        d: full.dir,
        v1: mid.value,
        r1: mid.rest,
        p1: pillImage(mid),
        v2: full.value,
        r2: full.rest,
        p2: pillImage(full),
        r3: rate.rest,
        p3: pillImage(rate),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------- the card's graph ----------

export interface GraphPoint {
  /** Hours from now (−8 … +16). */
  t: number;
  /** Height in the display unit. */
  v: number;
}

export interface TideGraphModel {
  /** Observed, the last 8 h (display unit). */
  observed: GraphPoint[];
  /** Predicted over the whole window (display unit), every 15 min. */
  predicted: GraphPoint[];
  /** Where "now" sits on the curve the card reads (observed if live, else predicted). */
  now: GraphPoint | null;
  /** The last observed point when it is old (drawn faded at its time). */
  lastObserved: GraphPoint | null;
  /** The next high and low inside the window, labelled. */
  marks: { t: number; v: number; label: string; kind: 'high' | 'low' }[];
  yTicks: number[];
  yMin: number;
  yMax: number;
  /** Clock ticks: hours from now and their label ("09"). */
  xTicks: { t: number; label: string }[];
  /** "m" / "ft". */
  unit: string;
}

/** Round grid steps for a range in display units (≥ 3 lines when possible). */
export function niceStep(range: number): number {
  for (const s of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20]) if (range / s <= 5) return s;
  return 50;
}

/**
 * The graph's series in the display unit: observed past (solid), predicted
 * curve (dashed), the "now" point, the next high and low, the grid. Null
 * when there is nothing to draw.
 */
export function tideGraph(
  series: TideSeries,
  nowMs: number,
  units: Units,
  clock: (ms: number) => string,
  tzOffsetMs = 0,
): TideGraphModel | null {
  const conv = (m: number) => toElevationUnit(m, units);
  const t0 = nowMs - GRAPH_PAST_MS;
  const t1 = nowMs + GRAPH_AHEAD_MS;
  const toH = (ms: number) => (ms - nowMs) / 3_600_000;
  const observed = series.observed
    .filter((r) => r.timeMs >= t0 && r.timeMs <= nowMs + 60_000)
    .map((r) => ({ t: toH(r.timeMs), v: conv(r.heightM) }));
  const predicted: GraphPoint[] = [];
  for (let t = t0; t <= t1; t += 15 * 60_000) {
    const h = predictedAt(series, t);
    if (h !== null) predicted.push({ t: toH(t), v: conv(h) });
  }
  if (observed.length === 0 && predicted.length === 0) return null;
  const reading = levelReading(series, nowMs);
  const lastObs = observed[observed.length - 1] ?? null;
  let now: GraphPoint | null = null;
  if (reading?.kind === 'live' && lastObs) now = { t: 0, v: lastObs.v };
  else {
    const h = predictedAt(series, nowMs);
    if (h !== null) now = { t: 0, v: conv(h) };
  }
  const nextHigh = series.extremes.find((e) => e.kind === 'high' && e.timeMs > nowMs);
  const nextLow = series.extremes.find((e) => e.kind === 'low' && e.timeMs > nowMs);
  const marks = [nextHigh, nextLow]
    .filter((e): e is TideExtreme => e !== undefined && e.timeMs <= t1)
    .map((e) => ({
      t: toH(e.timeMs),
      v: conv(e.heightM),
      kind: e.kind,
      label: `${e.kind === 'high' ? 'High' : 'Low'} ${clock(e.timeMs)} · ${conv(e.heightM).toFixed(2)}`,
    }));
  const all = [...observed, ...predicted].map((p) => p.v);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const step = niceStep(Math.max(hi - lo, 0.1));
  const yMin = Math.floor(lo / step) * step;
  let yMax = Math.ceil(hi / step) * step;
  // Room above the high water for its label.
  if (yMax - hi < step * 0.4) yMax += step;
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += step) yTicks.push(Number(v.toFixed(3)));
  // Clock ticks every 3 h on the phone's hours (`tzOffsetMs`: local − UTC).
  const xTicks: { t: number; label: string }[] = [];
  const H3 = 3 * 3_600_000;
  const first = Math.ceil((t0 + tzOffsetMs) / H3) * H3 - tzOffsetMs;
  for (let t = first; t <= t1; t += H3) xTicks.push({ t: toH(t), label: clock(t).slice(0, 2) });
  return {
    observed,
    predicted,
    now,
    lastObserved: reading?.kind === 'stale' && lastObs ? lastObs : null,
    marks,
    yTicks,
    yMin,
    yMax,
    xTicks,
    unit: units.elevation,
  };
}

/** Keep TideReading in this module's public surface (series inputs). */
export type { TideReading, TideExtreme };
