/**
 * A tide station's series for the map's level labels and the card's graph
 * (#764): its observed water level (the live gauge, last 12 h) and its
 * predictions (curve + highs and lows), each from the station's own agency.
 *
 * Request budget (owner-approved):
 * - observed: one request per station, at most every 10 min
 *   (`LEVELS_REFRESH_MS`), kept in memory for the session;
 * - predictions: fetched once a day (`PREDICTION_TTL_MS`, a 60 h window) and
 *   kept on the device under `Paths.document/tides/`, so the predicted
 *   labels, the dashed curve and the next high/low work offline;
 * - CHS requests go through its shared limiter (`chsGet`: 30/min, 3/s);
 * - the map and the card share one in-flight request per station.
 */
import {
  OBSERVED_WINDOW_MS,
  LEVELS_REFRESH_MS,
  PREDICTION_AHEAD_MS,
  PREDICTION_BACK_MS,
  PREDICTION_TTL_MS,
  classifyHiLo,
  extremesOfCurve,
  stationFeedsOf,
  type TideSeries,
} from '@core/tides/levels';
import {
  coopsObservedUrl,
  coopsPredictionsUrl,
  kvUrl,
  parseCoopsHiLo,
  parseCoopsLevels,
  parseCoopsPredictions,
  parseKartverket,
} from '@core/tides/live';
import { stationKey, type TideStation } from '@core/tides/station';
import {
  parseSeries,
  stationDataUrl,
  type TideExtreme,
  type TideReading,
} from '@core/weather/tides';
import { Directory, File, Paths } from 'expo-file-system';

import { chsGet } from './chsStations';

const TIMEOUT_MS = 12_000;
const DIR = 'tides';

/** One request with a timeout, aborting with `signal`. */
export async function fetchWithTimeout(
  url: string,
  signal: AbortSignal | undefined,
  as: 'json' | 'text',
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

interface Predictions {
  fetchedAt: number;
  predicted: TideReading[];
  extremes: TideExtreme[];
}

interface Observed {
  fetchedAt: number;
  observed: TideReading[];
}

const predictions = new Map<string, Predictions>();
const observations = new Map<string, Observed>();
const inflight = new Map<string, Promise<TideSeriesResult>>();

function fileFor(key: string): File | null {
  try {
    const d = new Directory(Paths.document, DIR);
    if (!d.exists) d.create({ intermediates: true });
    return new File(d, `pred-${key.replace(/[^a-zA-Z0-9.-]/g, '_')}.json`);
  } catch {
    return null;
  }
}

function isReadings(v: unknown): v is TideReading[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        Number.isFinite((r as TideReading).timeMs) &&
        Number.isFinite((r as TideReading).heightM),
    )
  );
}

function readPredictions(key: string): Predictions | null {
  const mem = predictions.get(key);
  if (mem) return mem;
  try {
    const f = fileFor(key);
    if (!f?.exists) return null;
    const raw = JSON.parse(f.textSync()) as Partial<Predictions>;
    if (
      typeof raw.fetchedAt !== 'number' ||
      !isReadings(raw.predicted) ||
      !isReadings(raw.extremes) ||
      !raw.extremes.every((e) => e.kind === 'high' || e.kind === 'low')
    ) {
      return null;
    }
    const p = { fetchedAt: raw.fetchedAt, predicted: raw.predicted, extremes: raw.extremes };
    predictions.set(key, p);
    return p;
  } catch {
    return null;
  }
}

function writePredictions(key: string, p: Predictions): void {
  predictions.set(key, p);
  try {
    const f = fileFor(key);
    if (!f) return;
    if (f.exists) f.delete();
    f.create();
    f.write(JSON.stringify(p));
  } catch {
    // A full disk never breaks the map: the copy stays in memory this session.
  }
}

async function fetchObserved(
  s: TideStation,
  signal: AbortSignal | undefined,
  now: number,
): Promise<TideReading[]> {
  const feed = stationFeedsOf(s).observed;
  const from = now - OBSERVED_WINDOW_MS;
  if (feed === 'coops') {
    return parseCoopsLevels(await fetchWithTimeout(coopsObservedUrl(s.id, now), signal, 'json'));
  }
  if (feed === 'kv') {
    const xml = await fetchWithTimeout(kvUrl(s.lat, s.lng, 'obs', from, now), signal, 'text');
    return parseKartverket(xml)
      .filter((r) => r.flag === 'obs')
      .map((r) => r.reading);
  }
  if (feed === 'chs' && s.iwlsId !== undefined) {
    return parseSeries(await chsGet(stationDataUrl(s.iwlsId, 'wlo', from, now), signal));
  }
  return [];
}

async function fetchPredictions(
  s: TideStation,
  signal: AbortSignal | undefined,
  now: number,
): Promise<Omit<Predictions, 'fetchedAt'>> {
  const feed = stationFeedsOf(s).predicted;
  const from = now - PREDICTION_BACK_MS;
  const to = now + PREDICTION_AHEAD_MS;
  const hours = Math.round((to - from) / 3_600_000);
  let predicted: TideReading[] = [];
  let extremes: TideExtreme[] = [];
  if (feed === 'coops' || feed === 'coops-hilo') {
    const [curve, hilo] = await Promise.all([
      feed === 'coops'
        ? fetchWithTimeout(coopsPredictionsUrl(s.id, from, hours, '30'), signal, 'json')
        : Promise.resolve(null),
      fetchWithTimeout(coopsPredictionsUrl(s.id, from, hours, 'hilo'), signal, 'json'),
    ]);
    predicted = parseCoopsPredictions(curve);
    extremes = parseCoopsHiLo(hilo);
  } else if (feed === 'kv') {
    const [pre, tab] = await Promise.all([
      fetchWithTimeout(kvUrl(s.lat, s.lng, 'pre', from, to), signal, 'text'),
      fetchWithTimeout(kvUrl(s.lat, s.lng, 'tab', from, to), signal, 'text'),
    ]);
    predicted = parseKartverket(pre)
      .filter((r) => r.flag === 'pre')
      .map((r) => r.reading);
    extremes = parseKartverket(tab)
      .filter((r) => r.flag === 'high' || r.flag === 'low')
      .map((r) => ({ ...r.reading, kind: r.flag as 'high' | 'low' }));
  } else if (feed === 'chs' && s.iwlsId !== undefined) {
    const [curve, hilo] = await Promise.all([
      chsGet(stationDataUrl(s.iwlsId, 'wlp', from, to), signal),
      chsGet(stationDataUrl(s.iwlsId, 'wlp-hilo', from, to), signal),
    ]);
    predicted = parseSeries(curve);
    extremes = classifyHiLo(parseSeries(hilo));
  }
  if (extremes.length === 0) extremes = extremesOfCurve(predicted);
  if (predicted.length === 0 && extremes.length === 0) throw new Error('no predictions');
  return { predicted, extremes };
}

export interface TideSeriesResult {
  series: TideSeries;
  /** Nothing new could be fetched: the device's copy only. */
  fromCache: boolean;
}

/** What is known without a request (offline, or before the first one). */
export function cachedTideSeries(s: TideStation): TideSeriesResult | null {
  const key = stationKey(s);
  const p = readPredictions(key);
  const o = observations.get(key);
  if (!p && !o) return null;
  return {
    series: {
      observed: o?.observed ?? [],
      predicted: p?.predicted ?? [],
      extremes: p?.extremes ?? [],
    },
    fromCache: true,
  };
}

async function load(s: TideStation, now: number): Promise<TideSeriesResult> {
  const key = stationKey(s);
  const feeds = stationFeedsOf(s);
  // A wanted request failed: what shows is the device's copy.
  let failed = false;
  let p = readPredictions(key);
  if (feeds.predicted !== null && (!p || now - p.fetchedAt > PREDICTION_TTL_MS)) {
    try {
      p = { fetchedAt: now, ...(await fetchPredictions(s, undefined, now)) };
      writePredictions(key, p);
    } catch {
      // Offline or the agency down: the device copy (any age) stays.
      failed = true;
    }
  }
  let o = observations.get(key) ?? null;
  if (feeds.observed !== null && (!o || now - o.fetchedAt >= LEVELS_REFRESH_MS)) {
    try {
      o = { fetchedAt: now, observed: await fetchObserved(s, undefined, now) };
      observations.set(key, o);
    } catch {
      // The last series stays: its readings age into "old".
      failed = true;
    }
  }
  if (!p && !o) throw new Error('no tide data');
  return {
    series: {
      observed: o?.observed ?? [],
      predicted: p?.predicted ?? [],
      extremes: p?.extremes ?? [],
    },
    fromCache: failed,
  };
}

/**
 * A station's series: fresh within the budget, else what the device holds.
 * Offline: the device copy only (throws when there is none). One request in
 * flight per station, shared by the map and the card, and never cancelled
 * half-way (each request has its own timeout): what it brings is kept.
 */
export function loadTideSeries(
  s: TideStation,
  options: { offline?: boolean; now?: number } = {},
): Promise<TideSeriesResult> {
  if (options.offline) {
    const cached = cachedTideSeries(s);
    return cached ? Promise.resolve(cached) : Promise.reject(new Error('offline'));
  }
  const key = stationKey(s);
  const running = inflight.get(key);
  if (running) return running;
  const promise = load(s, options.now ?? Date.now()).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** Tests: forget the session's copies. */
export function resetTideSeriesForTests(): void {
  predictions.clear();
  observations.clear();
  inflight.clear();
}
