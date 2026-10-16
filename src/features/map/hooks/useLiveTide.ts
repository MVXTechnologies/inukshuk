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
import { fetchWithTimeout as get } from '@data/tideSeries';

/**
 * One station's live level and next high / low from its own agency (two
 * requests; CHS ones through the shared IWLS limiter). Throws when offline.
 * The info strip's tide fields' source (#695); the card's graph and the map
 * labels read `@data/tideSeries` (#764).
 */
export async function loadLiveTide(s: TideStation, signal: AbortSignal): Promise<LiveTide> {
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
