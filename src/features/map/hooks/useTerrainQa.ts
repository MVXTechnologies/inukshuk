import { costStats, frameStats } from '@core/terrain3d/frameStats';
import { isTiltRelief } from '@core/map/tiltRelief';
import { writeQaReport } from '@data/qaReports';
import { namedTerrainStats, nativeTerrain } from '@lib/nativeTerrain';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import * as Linking from 'expo-linking';
import { useEffect, useState, type RefObject } from 'react';

/**
 * Visual-QA / fluidity harness for the native 3D terrain — compiled in only
 * when the bundle is built with `EXPO_PUBLIC_TERRAIN_QA=1` (a local QA
 * build), inert otherwise. Driven by deep links so a shell script can walk a
 * screenshot matrix and the gesture benchmark:
 *
 *   inukshuk://?tqa=1&lat=46.02&lng=7.75&zoom=13&pitch=70&bearing=30
 *     &basemap=map|satellite&theme=light|dark&relief=off|natural|dramatic
 *     &probe=0|1                      (1: attach as a 2D frame-timing probe)
 *     &bench=<label>                  (run the standard gesture script)
 *     &stats=<label>                  (dump engine stats)
 *
 * Reports land in `<documents>/qa/*.json`.
 */
export const TERRAIN_QA = process.env.EXPO_PUBLIC_TERRAIN_QA === '1';

export function useTerrainQa(
  cameraRef: RefObject<CameraRef | null>,
  tagRef: RefObject<number | null>,
): { probe: boolean } {
  const [probe, setProbe] = useState(false);

  useEffect(() => {
    if (!TERRAIN_QA) return;
    const handle = (url: string | null) => {
      if (!url) return;
      const { queryParams } = Linking.parse(url);
      const q = (k: string) => {
        const v = queryParams?.[k];
        return typeof v === 'string' ? v : undefined;
      };
      if (q('tqa') !== '1') return;
      const num = (k: string) => {
        const v = q(k);
        return v === undefined ? undefined : Number(v);
      };
      const settings = useSettingsStore.getState();
      const theme = q('theme');
      if (theme === 'light' || theme === 'dark') settings.set('themeMode', theme);
      const relief = q('relief');
      if (isTiltRelief(relief)) settings.set('tiltRelief', relief);
      const basemap = q('basemap');
      if (basemap === 'map' || basemap === 'satellite') useMapStore.getState().setBasemap(basemap);
      const p = q('probe');
      if (p === '0' || p === '1') setProbe(p === '1');
      const lat = num('lat');
      const lng = num('lng');
      if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
        useMapStore.getState().setFollowUser(false);
        void cameraRef.current?.setStop({
          center: [lng, lat],
          zoom: num('zoom') ?? 13,
          pitch: num('pitch') ?? 0,
          bearing: num('bearing') ?? 0,
          duration: 0,
        });
      }
      const module = nativeTerrain();
      const tag = tagRef.current;
      const bench = q('bench');
      if (bench && module && tag !== null) {
        void module.runBench(tag, []).then((r) => {
          if (!r) return;
          const report = {
            label: bench,
            at: new Date().toISOString(),
            frames: frameStats(r.frameTimesNs),
            layerCost: costStats(r.costNs),
            engine: namedTerrainStats(r.stats),
            raw: { frameTimesNs: r.frameTimesNs, costNs: r.costNs },
          };
          writeQaReport(`bench-${bench}`, report);
          console.log(`TERRAIN_BENCH ${JSON.stringify({ ...report, raw: undefined })}`);
        });
      }
      const stats = q('stats');
      if (stats && module && tag !== null) {
        void module.stats(tag).then((s) => {
          writeQaReport(`stats-${stats}`, namedTerrainStats(s));
          console.log(`TERRAIN_STATS ${stats} ${JSON.stringify(namedTerrainStats(s))}`);
        });
      }
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, [cameraRef, tagRef]);

  return { probe };
}
