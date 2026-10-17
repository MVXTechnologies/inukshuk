import { stationFeedsOf, type TideSeries } from '@core/tides/levels';
import { stationKey, type TideStation } from '@core/tides/station';
import { cachedTideSeries, loadTideSeries } from '@data/tideSeries';
import { useEffect, useMemo, useState } from 'react';

/**
 * The tide card's graph data (#764): the station's observed and predicted
 * series (`@data/tideSeries`: the map's labels and the card share one
 * request and one cache). What the device holds shows at once; the fresh
 * series replaces it when it lands.
 *
 * - 'none': the station has no feed (SHOM, JMA, historic): no graph;
 * - 'loading': nothing known yet;
 * - 'error': offline (or the agency down) with nothing on the device;
 * - 'ready': `fromCache` when nothing new could be fetched.
 */
export type TideSeriesQuery =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; series: TideSeries; fromCache: boolean };

export function useTideSeries(station: TideStation | null, offline: boolean): TideSeriesQuery {
  const feeds = station ? stationFeedsOf(station) : null;
  const has = feeds !== null && (feeds.observed !== null || feeds.predicted !== null);
  const key = station && has ? `${stationKey(station)}:${offline ? 'off' : 'on'}` : null;
  const [result, setResult] = useState<{ key: string; query: TideSeriesQuery } | null>(null);
  // The device's copy, read once per station: shown while the request runs.
  const cached = useMemo(
    () => (key !== null && station !== null ? cachedTideSeries(station) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  useEffect(() => {
    if (key === null || station === null) return;
    let cancelled = false;
    loadTideSeries(station, { offline })
      .then((r) => {
        if (!cancelled) setResult({ key, query: { status: 'ready', ...r } });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, query: { status: 'error' } });
      });
    return () => {
      cancelled = true;
    };
  }, [key, station, offline]);
  if (key === null) return { status: 'none' };
  const query = result !== null && result.key === key ? result.query : null;
  if (query !== null && (query.status !== 'error' || cached === null)) return query;
  return cached !== null ? { status: 'ready', ...cached } : { status: 'loading' };
}
