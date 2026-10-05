import {
  coopsHiLoUrl,
  coopsLevelUrl,
  kvExtremes,
  kvUrl,
  liveTide,
  LIVE_LOOKAHEAD_H,
  parseCoopsHiLo,
  parseCoopsLevels,
  parseKartverket,
  type LiveTide,
} from '@core/tides/live';
import type { TideStation } from '@core/tides/station';
import { nextHighLow, parseSeries, stationDataUrl } from '@core/weather/tides';
import { chsGet } from '@data/chsStations';
import { useEffect, useState } from 'react';

/**
 * The tide card's "Now" line: the station's own agency, live (NOAA CO-OPS or
 * Kartverket; two small requests per card open, nothing cached). Offline or
 * failing → 'error', and the card says "Live level needs a connection".
 * Stations without a live series never fetch.
 */
export type LiveTideQuery =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; live: LiveTide };

const TIMEOUT_MS = 12_000;

async function get(url: string, signal: AbortSignal, as: 'json' | 'text'): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function load(s: TideStation, signal: AbortSignal): Promise<LiveTide> {
  const now = Date.now();
  if (s.live === 'chs' && s.iwlsId !== undefined) {
    // CHS IWLS, live from the phone (rate-limited with the rest of CHS traffic).
    const [obs, hilo] = await Promise.all([
      chsGet(stationDataUrl(s.iwlsId, 'wlo', now - 3_600_000, now), signal).catch(() => null),
      chsGet(
        stationDataUrl(s.iwlsId, 'wlp-hilo', now, now + LIVE_LOOKAHEAD_H * 3_600_000),
        signal,
      ).catch(() => null),
    ]);
    if (obs === null && hilo === null) throw new Error('offline');
    const { nextHigh, nextLow } = nextHighLow(parseSeries(hilo), now);
    return liveTide(
      parseSeries(obs),
      [nextHigh, nextLow].filter((e) => e !== null),
      now,
    );
  }
  if (s.live === 'coops') {
    const [levels, hilo] = await Promise.all([
      get(coopsLevelUrl(s.id, now), signal, 'json').catch(() => null),
      get(coopsHiLoUrl(s.id, now), signal, 'json').catch(() => null),
    ]);
    if (levels === null && hilo === null) throw new Error('offline');
    return liveTide(parseCoopsLevels(levels), parseCoopsHiLo(hilo), now);
  }
  const [obs, tab] = await Promise.all([
    get(kvUrl(s.lat, s.lng, 'obs', now - 3_600_000, now), signal, 'text').catch(() => null),
    get(kvUrl(s.lat, s.lng, 'tab', now, now + LIVE_LOOKAHEAD_H * 3_600_000), signal, 'text').catch(
      () => null,
    ),
  ]);
  if (obs === null && tab === null) throw new Error('offline');
  const observed = parseKartverket(obs)
    .filter((r) => r.flag === 'obs')
    .map((r) => r.reading);
  return liveTide(observed, kvExtremes(parseKartverket(tab), now), now);
}

export function useLiveTide(station: TideStation | null, offline: boolean): LiveTideQuery {
  const key = station?.live && !offline ? `${station.source}:${station.id}` : null;
  const [result, setResult] = useState<{ key: string; query: LiveTideQuery } | null>(null);
  useEffect(() => {
    if (key === null || station === null) return;
    const controller = new AbortController();
    let cancelled = false;
    load(station, controller.signal)
      .then((live) => {
        if (!cancelled) setResult({ key, query: { status: 'ready', live } });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, query: { status: 'error' } });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, station]);
  if (station?.live && offline) return { status: 'error' };
  if (key === null) return { status: 'none' };
  return result !== null && result.key === key ? result.query : { status: 'loading' };
}
