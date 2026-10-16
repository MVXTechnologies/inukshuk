/**
 * The app's Share live wiring (#712): the library bridge over the real
 * Library (`libraryStore`, GPX files) and the team service's groups. The
 * bridge is the only code that writes synced changes into the Library
 * (`applySync`, one index write per run).
 */
import { buildGpx, parseGpx } from '@core/geo/gpx';
import { buildImportedTrack } from '@core/geo/track';
import type { LatLng, LngLat, TrackPoint, TrackSummary } from '@core/models';
import { isTeamId } from '@core/team/ids';
import * as storage from '@data/storage';
import { appTeamService } from '@data/team/appTeam';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';

import {
  LibraryBridge,
  type BridgeDisk,
  type BridgeRecord,
  type LibraryPort,
} from './libraryBridge';
import { LibraryGroups, type DismissedStore } from './libraryGroups';

export const libraryStorePort: LibraryPort = {
  snapshot: () => useLibraryStore.getState(),
  async trackPoints(t: TrackSummary): Promise<readonly LatLng[] | undefined> {
    try {
      return parseGpx(await storage.readFileText(t.fileUri)).points;
    } catch (e) {
      reportError(e, 'share-live-read-gpx');
      return undefined;
    }
  },
  writeTrack(id: string, name: string, points: readonly LngLat[]): TrackSummary {
    const pts: TrackPoint[] = points.map(([longitude, latitude]) => ({
      latitude,
      longitude,
      time: 0,
      hasTime: false,
    }));
    const fileUri = storage.writeTrackGpx(id, buildGpx({ points: pts, metadata: { name } }));
    const track = buildImportedTrack({
      id,
      points: pts,
      name,
      fallbackName: name,
      fallbackTime: Date.now(),
    });
    return {
      id,
      name: track.name,
      startedAt: track.startedAt,
      stats: track.stats,
      fileUri,
      // A shared trail carries no timestamps: a route to follow.
      category: 'navigation',
    };
  },
  apply: (edit) => {
    useLibraryStore.getState().applySync(edit);
  },
  newId: storage.newId,
  subscribe: (fn) => useLibraryStore.subscribe(fn),
};

const recordPath = (groupId: string) => {
  if (!isTeamId(groupId)) throw new Error('bad group id');
  return `teams/${groupId}/library.json`;
};

export const fsBridgeDisk: BridgeDisk = {
  load: (groupId) => storage.readJson<BridgeRecord>(recordPath(groupId)),
  save: (groupId, record) => {
    try {
      storage.writeJson(recordPath(groupId), record);
    } catch (e) {
      reportError(e, 'share-live-save');
    }
  },
  remove: (groupId) => {
    try {
      storage.deleteJson(recordPath(groupId));
    } catch {
      // The group's directory goes with it anyway.
    }
  },
};

const DISMISSED = 'teams/library-dismissed.json';

export const fsDismissed: DismissedStore = {
  load: async () => {
    const ids = await storage.readJson<unknown>(DISMISSED);
    return Array.isArray(ids) ? ids.filter((x): x is string => isTeamId(x)) : [];
  },
  save: (ids) => {
    try {
      storage.writeJson(DISMISSED, ids.slice(-500));
    } catch (e) {
      reportError(e, 'share-live-dismissed');
    }
  },
};

let bridge: LibraryBridge | null | undefined;

/** The app's library bridge; null where team mode is unavailable (an older binary). */
export function appLibraryBridge(): LibraryBridge | null {
  if (bridge !== undefined) return bridge;
  const service = appTeamService();
  bridge =
    service === null
      ? null
      : new LibraryBridge(
          new LibraryGroups(service.host, fsDismissed),
          libraryStorePort,
          fsBridgeDisk,
        );
  return bridge;
}

/** Start Share live once the Library has hydrated (the app root calls it). */
export function startLibrarySync(): void {
  const b = appLibraryBridge();
  const service = appTeamService();
  if (b === null || service === null) return;
  b.start((fn) => service.subscribe(fn));
}
