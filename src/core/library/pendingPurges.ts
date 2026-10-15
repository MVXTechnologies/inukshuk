import type { Area, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { removedFileUris, type RemovedItems } from './bulkEdits';

/**
 * The Library's purge journal (#711 follow-up): a bulk delete with Undo takes
 * the items out of the index at once and deletes their files only once the
 * Undo window has passed. If the app is killed inside that window, the index
 * on disk no longer names the items but their files are still there: a
 * half-deleted state nothing would ever clean up.
 *
 * So the delete writes, IN THE SAME index write, a journal entry naming the
 * files (and the trails whose photo folders go with them). Undo drops the
 * entry in the write that puts the items back; the purge drops it once the
 * files are gone. Whatever is still in the journal at the next launch is a
 * delete that stood (the Undo can no longer be pressed): its files are
 * purged then, and the items stay deleted. A file the live index names again
 * is never purged, whatever the journal says.
 */
export interface PendingPurge {
  /** The delete's id (one per Undo-able delete). */
  id: string;
  /** Files to delete: PDFs, GPX files, photos. */
  fileUris: string[];
  /** Trails whose photo folders (#587) go with them. */
  trackIds: string[];
}

/** The journal entry of one Undo-able delete. */
export function pendingPurgeOf(id: string, removed: RemovedItems): PendingPurge {
  return {
    id,
    fileUris: removedFileUris(removed),
    trackIds: removed.tracks.map((r) => r.item.id),
  };
}

/** The journal without one delete's entry (Undo, or its purge done). */
export function withoutPurge(
  journal: readonly PendingPurge[] | undefined,
  id: string | undefined,
): PendingPurge[] {
  return (journal ?? []).filter((p) => p.id !== id);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

/** A persisted journal, sanitized: junk entries are dropped, never thrown on. */
export function sanitizePendingPurges(raw: unknown): PendingPurge[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingPurge[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id === '') continue;
    out.push({ id: r.id, fileUris: strings(r.fileUris), trackIds: strings(r.trackIds) });
  }
  return out;
}

/** The items a live index still holds (what a launch purge must never touch). */
export interface LiveItems {
  maps: readonly MapDocument[];
  tracks: readonly TrackSummary[];
  waypoints: readonly Waypoint[];
  areas: readonly Area[];
}

/**
 * What to delete at launch for the journal's leftover entries: their files
 * and trail photo folders, minus anything the live index names (an entry
 * whose index write never landed, or an item back by Undo before a kill).
 * Each file and folder once.
 */
export function launchPurgePlan(
  journal: readonly PendingPurge[],
  live: LiveItems,
): { fileUris: string[]; trackIds: string[] } {
  const referenced = new Set(
    removedFileUris({
      maps: live.maps.map((item, index) => ({ item, index })),
      tracks: live.tracks.map((item, index) => ({ item, index })),
      waypoints: live.waypoints.map((item, index) => ({ item, index })),
      areas: live.areas.map((item, index) => ({ item, index })),
      activeTrackIds: [],
      activeMapId: null,
    }),
  );
  const liveTracks = new Set(live.tracks.map((t) => t.id));
  const fileUris = new Set<string>();
  const trackIds = new Set<string>();
  for (const p of journal) {
    for (const uri of p.fileUris) if (!referenced.has(uri)) fileUris.add(uri);
    for (const id of p.trackIds) if (!liveTracks.has(id)) trackIds.add(id);
  }
  return { fileUris: [...fileUris], trackIds: [...trackIds] };
}
