import { useCallback, useEffect, useMemo, useState } from 'react';

import { parseGpx } from '@core/geo/gpx';
import { computeTrackStats } from '@core/geo/track';
import type { TrackPoint, TrackStats } from '@core/models';

import { idb, TRACK_STORE } from '@/lib/idb';
import type { TrackFeature } from '@/map/useMapOverlays';

/** Track line colours, cycled by import order. Chosen to stay legible over
 *  every part of the weather ramps in both themes. */
const PALETTE = ['#F2643C', '#FFC24B', '#5BD2A4', '#61B4F2', '#C48AF0', '#F98BB8'];

export interface StoredTrack {
  id: string;
  name: string;
  color: string;
  importedAt: number;
  points: TrackPoint[];
  stats: TrackStats;
  /** Standalone <wpt> count, kept only so the UI can mention them. */
  waypointCount: number;
}

export interface TracksState {
  tracks: StoredTrack[];
  features: TrackFeature[];
  /** Parse + persist one or more dropped files. Returns a summary to toast. */
  importFiles: (files: readonly File[]) => Promise<string>;
  remove: (id: string) => void;
  clear: () => void;
  ready: boolean;
}

/**
 * Imported GPX tracks.
 *
 * The parsing is `@core/geo/gpx#parseGpx` and the numbers are
 * `@core/geo/track#computeTrackStats` — both untouched. They are pure
 * TypeScript with one npm dependency (fast-xml-parser) and no platform
 * assumptions at all, so they run in a browser exactly as they run under Jest
 * and on the phone. Distance, D+/D-, moving time and the bbox you see in this
 * panel are computed by the same code that computes them on device.
 */
export function useTracks(): TracksState {
  const [tracks, setTracks] = useState<StoredTrack[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await idb.getAll<StoredTrack>(TRACK_STORE);
        stored.sort((a, b) => a.importedAt - b.importedAt);
        setTracks(stored);
      } catch {
        // A blocked/absent IndexedDB (private mode) must not take the app down;
        // imports simply stop surviving a reload.
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const importFiles = useCallback(
    async (files: readonly File[]): Promise<string> => {
      const added: StoredTrack[] = [];
      const failed: string[] = [];

      for (const file of files) {
        try {
          const doc = parseGpx(await file.text());
          if (doc.points.length < 2) {
            failed.push(`${file.name} (no track points)`);
            continue;
          }
          const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const track: StoredTrack = {
            id,
            name: doc.metadata.name ?? file.name.replace(/\.gpx$/i, ''),
            color: PALETTE[(tracks.length + added.length) % PALETTE.length] ?? '#F2643C',
            importedAt: Date.now(),
            points: doc.points,
            stats: computeTrackStats(doc.points),
            waypointCount: doc.waypoints.length,
          };
          added.push(track);
          await idb.put(TRACK_STORE, id, track).catch(() => undefined);
        } catch {
          failed.push(file.name);
        }
      }

      if (added.length > 0) setTracks((prev) => [...prev, ...added]);
      if (added.length === 0) return `Could not read ${failed.join(', ') || 'that file'}`;
      const noun = added.length === 1 ? 'track' : 'tracks';
      const tail = failed.length > 0 ? ` · ${failed.length} failed` : '';
      return `Imported ${added.length} ${noun}${tail}`;
    },
    [tracks.length],
  );

  const remove = useCallback((id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
    void idb.remove(TRACK_STORE, id).catch(() => undefined);
  }, []);

  const clear = useCallback(() => {
    setTracks([]);
    void idb.clear(TRACK_STORE).catch(() => undefined);
  }, []);

  const features = useMemo<TrackFeature[]>(
    () =>
      tracks.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        coordinates: t.points.map((p): [number, number] => [p.longitude, p.latitude]),
      })),
    [tracks],
  );

  return { tracks, features, importFiles, remove, clear, ready };
}
