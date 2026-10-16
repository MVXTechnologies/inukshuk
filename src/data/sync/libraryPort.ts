/**
 * The app's Share live wiring (#712): the library bridge over the real
 * Library (`libraryStore`, GPX files) and the team service's groups. The
 * bridge is the only code that writes synced changes into the Library
 * (`applySync`, one index write per run).
 */
import { buildGpx, parseGpx } from '@core/geo/gpx';
import { buildImportedTrack } from '@core/geo/track';
import type { CodecTrack } from '@core/domains/library/trackCodec';
import type { TrackPoint, TrackSummary } from '@core/models';
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
import { LiveFolders } from './liveFolders';

export const libraryStorePort: LibraryPort = {
  snapshot: () => useLibraryStore.getState(),
  async trackPoints(t: TrackSummary) {
    try {
      const gpx = parseGpx(await storage.readFileText(t.fileUri));
      return { points: gpx.points, segmentStarts: gpx.segmentStarts };
    } catch (e) {
      reportError(e, 'share-live-read-gpx');
      return undefined;
    }
  },
  writeTrack(id: string, name: string, track: CodecTrack, category?: string): TrackSummary {
    const points: TrackPoint[] = track.points.map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      time: p.time,
      ...(p.altitude !== undefined ? { altitude: p.altitude } : {}),
      ...(p.hasTime === false ? { hasTime: false } : {}),
    }));
    const segmentStarts = track.segmentStarts;
    const fileUri = storage.writeTrackGpx(
      id,
      buildGpx({ points, metadata: { name }, segmentStarts }),
    );
    const built = buildImportedTrack({
      id,
      points,
      name,
      fallbackName: name,
      fallbackTime: Date.now(),
      segmentStarts,
      category: category ?? null,
    });
    // A trail without times is a route to follow (as a GPX import files it).
    const timed = points.some((p) => p.hasTime !== false);
    const kind = category ?? (timed ? undefined : 'navigation');
    return {
      id,
      name: built.name,
      startedAt: built.startedAt,
      ...(built.endedAt !== undefined ? { endedAt: built.endedAt } : {}),
      stats: built.stats,
      fileUri,
      ...(kind !== undefined ? { category: kind } : {}),
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
let started = false;

export function startLibrarySync(): void {
  if (started) return;
  const b = appLibraryBridge();
  const service = appTeamService();
  if (b === null || service === null) return;
  started = true;
  b.start((fn) => service.subscribe(fn));
}

let live: LiveFolders | null | undefined;

/** What the Share live screens read and do (null where team mode is unavailable). */
export function appLiveFolders(): LiveFolders | null {
  if (live !== undefined) return live;
  const b = appLibraryBridge();
  live = b === null ? null : new LiveFolders(b, b.groups);
  return live;
}
