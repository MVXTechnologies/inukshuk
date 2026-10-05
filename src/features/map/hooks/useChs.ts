import {
  CHS_SOURCE_INDEX,
  chsStation,
  parseChsMetadata,
  type ChsDetail,
  type ChsFeatureCollection,
} from '@core/tides/chs';
import type { TideStation } from '@core/tides/station';
import {
  cachedChsStations,
  chsHeightTypes,
  chsListIsStale,
  chsMetadata,
  refreshChsStations,
} from '@data/chsStations';
import { useEffect, useMemo, useState } from 'react';

/**
 * The CHS (Canada) stations for the Tide stations overlay, from the device's
 * own copy (offline after the first load), refreshed weekly when online — one
 * IWLS call. Null until anything is known (no CHS layer drawn).
 */
export function useChsStations(enabled: boolean, offline: boolean): ChsFeatureCollection | null {
  // The device copy, read once when the overlay turns on.
  const cached = useMemo(() => (enabled ? cachedChsStations() : null), [enabled]);
  const [fresh, setFresh] = useState<ChsFeatureCollection | null>(null);
  useEffect(() => {
    if (!enabled || offline || !chsListIsStale(cached)) return;
    const controller = new AbortController();
    refreshChsStations(controller.signal)
      .then((list) => setFresh(list.data))
      .catch(() => {
        // Offline / CHS down: the cached copy (if any) stays on the map.
      });
    return () => controller.abort();
  }, [enabled, offline, cached]);
  return enabled ? (fresh ?? cached?.data ?? null) : null;
}

export type ChsDetailQuery =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; station: TideStation; fromCache: boolean };

function needsRef(d: ChsDetail): boolean {
  const codes = new Set(d.levels.map((l) => l.code));
  return !(codes.has('HAT') && codes.has('LAT'));
}

/**
 * A tapped CHS station's published levels and CD offsets (its metadata, and
 * its reference port's when it lacks HAT/LAT), live and cached on the device.
 */
export function useChsStationDetail(stub: TideStation | null): ChsDetailQuery {
  const isChs = stub !== null && stub.source === CHS_SOURCE_INDEX && stub.iwlsId !== undefined;
  const key = isChs ? `${stub.iwlsId}` : null;
  const [result, setResult] = useState<{ key: string; query: ChsDetailQuery } | null>(null);
  useEffect(() => {
    if (key === null || stub === null || stub.iwlsId === undefined) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const types = await chsHeightTypes(controller.signal);
        const meta = await chsMetadata(stub.iwlsId ?? '', controller.signal);
        if (meta === null || types.size === 0) throw new Error('no CHS data');
        const detail = parseChsMetadata(meta.json, types);
        let ref: { id: string; name: string; detail: ChsDetail } | undefined;
        if (detail.referencePortId && needsRef(detail)) {
          const refMeta = await chsMetadata(detail.referencePortId, controller.signal);
          const feature = cachedChsStations()?.data.features.find(
            (f) => f.properties.ci === detail.referencePortId,
          );
          if (refMeta) {
            ref = {
              id: String(feature?.properties.i ?? detail.referencePortId),
              name: String(feature?.properties.n ?? 'reference port'),
              detail: parseChsMetadata(refMeta.json, types),
            };
          }
        }
        if (!cancelled) {
          setResult({
            key,
            query: {
              status: 'ready',
              station: chsStation(stub, detail, ref),
              fromCache: meta.fromCache,
            },
          });
        }
      } catch {
        if (!cancelled) setResult({ key, query: { status: 'error' } });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, stub]);
  if (key === null) return { status: 'none' };
  return result !== null && result.key === key ? result.query : { status: 'loading' };
}
