import { costStats, frameStats } from '@core/terrain3d/frameStats';
import { isTiltRelief } from '@core/map/tiltRelief';
import { readQaCommand, writeQaReport } from '@data/qaReports';
import * as storage from '@data/storage';
import { importGpxFromUri } from '@features/library/importGpx';
import { mapDocumentFromStoredPdf } from '@features/library/importMap';
import { namedTerrainStats, nativeTerrain } from '@lib/nativeTerrain';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useLibraryStore } from '@state/libraryStore';
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
 *     &n3d=0|1                        (0: native 3D off — the 2D "before")
 *     &pdf=<url>  &gpx=<url>          (import a GeoPDF overlay / a trail, shown)
 *     &pdfs=0|1                       (the "PDF maps" master switch)
 *     &bench=<label>                  (run the standard gesture script)
 *     &stats=<label>                  (dump engine stats)
 *     &trim=1                         (the low-memory path, as on a warning)
 *
 * Reports land in `<documents>/qa/*.json`.
 */
export const TERRAIN_QA = process.env.EXPO_PUBLIC_TERRAIN_QA === '1';

export function useTerrainQa(
  cameraRef: RefObject<CameraRef | null>,
  tagRef: RefObject<number | null>,
): { probe: boolean; disabled: boolean; debugFlags: number } {
  const [probe, setProbe] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [debugFlags, setDebugFlags] = useState(0);

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
      const pdfs = q('pdfs');
      if (pdfs === '0' || pdfs === '1') settings.set('showPdfOverlay', pdfs === '1');
      const relief = q('relief');
      if (isTiltRelief(relief)) settings.set('tiltRelief', relief);
      const basemap = q('basemap');
      if (basemap === 'map' || basemap === 'satellite') useMapStore.getState().setBasemap(basemap);
      const p = q('probe');
      if (p === '0' || p === '1') setProbe(p === '1');
      const n3d = q('n3d');
      if (n3d === '0' || n3d === '1') setDisabled(n3d === '0');
      const dbg = num('dbg');
      if (dbg !== undefined && Number.isFinite(dbg)) setDebugFlags(dbg);
      const pdf = q('pdf');
      if (pdf) void importQaPdf(pdf);
      const gpx = q('gpx');
      if (gpx) void importQaGpx(gpx);
      const lat = num('lat');
      const lng = num('lng');
      const jumpMod = nativeTerrain();
      const jumpTag = tagRef.current;
      if (
        lat !== undefined &&
        lng !== undefined &&
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        jumpMod?.jumpTo !== undefined &&
        jumpTag !== null
      ) {
        // One native move: the RN camera stop can be dropped after a native pitch.
        useMapStore.getState().setFollowUser(false);
        void jumpMod.jumpTo(
          jumpTag,
          lat,
          lng,
          num('zoom') ?? 13,
          num('pitch') ?? 0,
          num('bearing') ?? 0,
        );
      } else if (
        lat !== undefined &&
        lng !== undefined &&
        Number.isFinite(lat) &&
        Number.isFinite(lng)
      ) {
        useMapStore.getState().setFollowUser(false);
        void cameraRef.current?.setStop({
          center: [lng, lat],
          zoom: num('zoom') ?? 13,
          pitch: num('pitch') ?? 0,
          bearing: num('bearing') ?? 0,
          duration: 0,
        });
        // MapLibre Android's CameraPosition.Builder clamps a programmatic
        // pitch to 60°; past that, set it natively (gestures are unaffected).
        const pitch = num('pitch') ?? 0;
        const tag = tagRef.current;
        const mod = nativeTerrain();
        if (pitch > 60 && mod && tag !== null) {
          // Late enough that the jump above has landed: setPitch re-applies the
          // camera it reads, so an early call would snap back to the old place.
          setTimeout(() => void mod.setPitch(tag, pitch), 1500);
        }
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
      if (q('trim') === '1' && module && tag !== null) void module.trimMemory(tag);
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
    // The same commands through a file (iOS simulator: no "Open in" prompt).
    let last: string | null = readQaCommand();
    const poll = setInterval(() => {
      const cmd = readQaCommand();
      if (cmd !== null && cmd !== last) {
        last = cmd;
        for (const line of cmd.split('\n'))
          if (line.trim()) handle(line.trim().replace(/^#\d+ /, ''));
      }
    }, 400);
    return () => {
      sub.remove();
      clearInterval(poll);
    };
  }, [cameraRef, tagRef]);

  return { probe, disabled, debugFlags };
}

async function importQaPdf(url: string): Promise<void> {
  try {
    const id = storage.newId();
    const cached = await storage.downloadToCacheUri(url, `qa-${id}.pdf`);
    const fileUri = await storage.importPdf(cached, id);
    const doc = await mapDocumentFromStoredPdf(id, fileUri, 'QA overlay');
    useLibraryStore.getState().addMap(doc);
    console.log(`TERRAIN_QA pdf imported ${doc.georeferences.length} page(s)`);
  } catch (e) {
    console.log(`TERRAIN_QA pdf failed ${String(e)}`);
  }
}

async function importQaGpx(url: string): Promise<void> {
  try {
    const cached = await storage.downloadToCacheUri(url, `qa-${storage.newId()}.gpx`);
    const t = await importGpxFromUri(cached, 'QA trail');
    const lib = useLibraryStore.getState();
    if (lib.addTrack(t.track, t.fileUri, t.notes)) lib.toggleTrackOverlay(t.track.id);
    console.log('TERRAIN_QA gpx imported');
  } catch (e) {
    console.log(`TERRAIN_QA gpx failed ${String(e)}`);
  }
}
