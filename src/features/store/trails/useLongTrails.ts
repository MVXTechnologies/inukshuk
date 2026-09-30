import type { LngLat } from '@core/models';
import { rankTrails, type RankedTrail } from '@core/trails/rank';
import { useLongTrailsStore } from '@state/longTrailsStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useMemo } from 'react';

/**
 * Where "near you" is measured from (#467): the last GPS fix, else where the
 * map was last looking, else nowhere (the lists then rank by popularity alone,
 * worldwide).
 */
export function useTrailOrigin(): LngLat | null {
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const center = useMapStore((s) => s.mapCenter);
  return useMemo(() => {
    const p = position ?? center;
    return p === null ? null : [p.longitude, p.latitude];
  }, [position, center]);
}

/** The index (loading it once) ranked from the origin; `ranked` is empty until it's in. */
export function useRankedTrails(): {
  status: ReturnType<typeof useLongTrailsStore.getState>['status'];
  ranked: RankedTrail[];
  origin: LngLat | null;
} {
  const status = useLongTrailsStore((s) => s.status);
  const index = useLongTrailsStore((s) => s.index);
  const load = useLongTrailsStore((s) => s.load);
  const origin = useTrailOrigin();
  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);
  const ranked = useMemo(
    () => (index === null ? [] : rankTrails(index.trails, origin)),
    [index, origin],
  );
  return { status, ranked, origin };
}
