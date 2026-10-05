/**
 * The tide card's live "Now" line: the latest observed water level above
 * chart datum and the next high / low, from the station's own agency.
 *
 * - NOAA CO-OPS data API (public domain, no key):
 *   datagetter?product=water_level&date=latest&datum=MLLW&units=metric → {data:[{t,v}]}
 *   datagetter?product=predictions&interval=hilo&begin_date=…&range=36 → {predictions:[{t,v,type:H|L}]}
 *   Times are GMT ("2026-10-05 13:06").
 * - Kartverket tide API (CC BY 4.0, no key), XML, cm above CD:
 *   locationdata&datatype=obs&refcode=cd → <waterlevel value time flag="obs"/>
 *   locationdata&datatype=tab&refcode=cd → <waterlevel value time flag="high|low"/>
 *
 * CHS (Canada) is not here: Canadian stations aren't in our layer (owner
 * decision PLAN Q1 = c); the forecast card's IWLS code stays the only CHS use.
 *
 * Same discipline as `@core/weather/tides`: parsers are total — any input in,
 * a usable result (or null / empty) out. Endpoints verified live 2026-10-05.
 */
import { nextHighLow, type TideExtreme, type TideReading } from '@core/weather/tides';

export const COOPS_DATA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
export const KV_TIDE_URL = 'https://vannstand.kartverket.no/tideapi.php';
const APP = 'Inukshuk';

/** An observed level older than this is not "now". */
export const LIVE_MAX_AGE_MS = 60 * 60_000;
/** Lookahead for the next high and low. */
export const LIVE_LOOKAHEAD_H = 36;

export interface LiveTide {
  level: { heightM: number; timeMs: number } | null;
  /** Rising / falling over the last observations (null when unknown). */
  trend: 'rising' | 'falling' | null;
  nextHigh: TideExtreme | null;
  nextLow: TideExtreme | null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "yyyyMMdd HH:mm" in GMT, CO-OPS's begin_date format. */
function coopsDate(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The last hour of 6-minute observations (enough for "now" and the trend). */
export function coopsLevelUrl(stationId: string, nowMs: number): string {
  return (
    `${COOPS_DATA_URL}?product=water_level&begin_date=${encodeURIComponent(coopsDate(nowMs - 3_600_000))}` +
    `&range=1&station=${encodeURIComponent(stationId)}` +
    `&datum=MLLW&units=metric&time_zone=gmt&format=json&application=${APP}`
  );
}

export function coopsHiLoUrl(stationId: string, nowMs: number): string {
  return (
    `${COOPS_DATA_URL}?product=predictions&interval=hilo&begin_date=${encodeURIComponent(coopsDate(nowMs))}` +
    `&range=${LIVE_LOOKAHEAD_H}&station=${encodeURIComponent(stationId)}` +
    `&datum=MLLW&units=metric&time_zone=gmt&format=json&application=${APP}`
  );
}

export function kvUrl(
  lat: number,
  lng: number,
  kind: 'obs' | 'tab',
  fromMs: number,
  toMs: number,
): string {
  return (
    `${KV_TIDE_URL}?tide_request=locationdata&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}` +
    `&datatype=${kind}&refcode=cd&lang=en&fromtime=${iso(fromMs)}&totime=${iso(toMs)}` +
    `&interval=10&dst=0&tzone=0`
  );
}

function coopsTime(t: unknown): number {
  return typeof t === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)
    ? Date.parse(`${t.replace(' ', 'T')}:00Z`)
    : NaN;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** CO-OPS water_level JSON → readings, time-sorted. */
export function parseCoopsLevels(json: unknown): TideReading[] {
  const data = rec(json)?.data;
  if (!Array.isArray(data)) return [];
  const out: TideReading[] = [];
  for (const r of data) {
    const o = rec(r);
    if (!o) continue;
    const heightM = typeof o.v === 'string' && o.v.trim() !== '' ? Number(o.v) : NaN;
    const timeMs = coopsTime(o.t);
    if (Number.isFinite(heightM) && Number.isFinite(timeMs)) out.push({ timeMs, heightM });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/** CO-OPS hilo predictions JSON → extremes (the API labels H / L). */
export function parseCoopsHiLo(json: unknown): TideExtreme[] {
  const data = rec(json)?.predictions;
  if (!Array.isArray(data)) return [];
  const out: TideExtreme[] = [];
  for (const r of data) {
    const o = rec(r);
    if (!o) continue;
    const heightM = typeof o.v === 'string' ? Number(o.v) : NaN;
    const timeMs = coopsTime(o.t);
    const kind = o.type === 'H' ? 'high' : o.type === 'L' ? 'low' : null;
    if (kind && Number.isFinite(heightM) && Number.isFinite(timeMs))
      out.push({ timeMs, heightM, kind });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

const KV_LEVEL = /<waterlevel\s+value="(-?\d+(?:\.\d+)?)"\s+time="([^"]+)"\s+flag="(\w+)"\s*\/>/g;

/** Kartverket XML → readings (cm → m) with their flag; anything malformed is skipped. */
export function parseKartverket(xml: unknown): { reading: TideReading; flag: string }[] {
  if (typeof xml !== 'string') return [];
  const out: { reading: TideReading; flag: string }[] = [];
  for (const m of xml.matchAll(KV_LEVEL)) {
    const heightM = Math.round(Number(m[1]) * 10) / 1000; // cm (0.1) → m, exact to the mm
    const timeMs = Date.parse(m[2] ?? '');
    if (Number.isFinite(heightM) && Number.isFinite(timeMs)) {
      out.push({ reading: { timeMs, heightM }, flag: m[3] ?? '' });
    }
  }
  return out.sort((a, b) => a.reading.timeMs - b.reading.timeMs);
}

function trendOf(readings: readonly TideReading[]): LiveTide['trend'] {
  if (readings.length < 2) return null;
  const last = readings[readings.length - 1];
  const prev = readings[Math.max(0, readings.length - 4)];
  if (!last || !prev || last.timeMs === prev.timeMs) return null;
  const d = last.heightM - prev.heightM;
  return Math.abs(d) < 0.005 ? null : d > 0 ? 'rising' : 'falling';
}

/** The latest observed reading if it is fresh, plus trend and the next high / low after `nowMs`. */
export function liveTide(
  observed: readonly TideReading[],
  extremes: readonly TideExtreme[],
  nowMs: number,
): LiveTide {
  const last = observed[observed.length - 1];
  const fresh =
    last !== undefined && nowMs - last.timeMs <= LIVE_MAX_AGE_MS && last.timeMs <= nowMs + 60_000;
  const upcoming = extremes.filter((e) => e.timeMs > nowMs);
  const nextHigh = upcoming.find((e) => e.kind === 'high') ?? null;
  const nextLow = upcoming.find((e) => e.kind === 'low') ?? null;
  return {
    level: fresh && last ? { heightM: last.heightM, timeMs: last.timeMs } : null,
    trend: fresh ? trendOf(observed) : null,
    nextHigh,
    nextLow,
  };
}

/** Kartverket high/low rows → extremes (flags high / low), via the shared classifier as a fallback. */
export function kvExtremes(
  rows: readonly { reading: TideReading; flag: string }[],
  nowMs: number,
): TideExtreme[] {
  const labelled = rows
    .filter((r) => r.flag === 'high' || r.flag === 'low')
    .map((r) => ({ ...r.reading, kind: r.flag as 'high' | 'low' }));
  if (labelled.length > 0) return labelled;
  const { nextHigh, nextLow } = nextHighLow(
    rows.map((r) => r.reading),
    nowMs,
  );
  return [nextHigh, nextLow].filter((e): e is TideExtreme => e !== null);
}

/** "Water 1.23 m above MLLW · rising · next high 14:52 (1.57 m)" — the card's Now line. */
export function nowLine(
  live: LiveTide,
  cdLabel: string,
  clock: (ms: number) => string,
): string | null {
  const parts: string[] = [];
  if (live.level) {
    parts.push(`Water ${live.level.heightM.toFixed(2)} m above ${cdLabel}`);
    if (live.trend) parts.push(live.trend);
  }
  const next = [live.nextHigh, live.nextLow]
    .filter((e): e is TideExtreme => e !== null)
    .sort((a, b) => a.timeMs - b.timeMs)[0];
  if (next) parts.push(`next ${next.kind} ${clock(next.timeMs)} (${next.heightM.toFixed(2)} m)`);
  return parts.length ? parts.join(' · ').replace(/-(\d)/g, '−$1') : null;
}
