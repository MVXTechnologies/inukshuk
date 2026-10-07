import { Directory, File } from 'expo-file-system';

import type { TrackPoint } from '@core/models';
import {
  livePhotos,
  sidecarWritable,
  type SidecarStatus,
  type TrackPhoto,
} from '@core/photos/model';
import { photoFilePaths, trailPhotoDir } from '@core/photos/paths';
import { reanchorAfterTrim, reanchorOnTrail } from '@core/photos/reanchor';
import { editPhoto, tombstone } from '@core/photos/record';
import { orderPhotos } from '@core/photos/stack';
import { indexTrack, type TrailPosition } from '@core/photos/trackIndex';
import { resolveDocumentPath } from '@data/storage';

import { deletePhotoFiles, deleteTrailPhotos, sweepTrailOrphans } from './photoFiles';
import { readSidecar, readWritableSidecar, updateSidecar, writeSidecar } from './sidecarStore';

/**
 * A trail's photos, day to day (#587): load, edit, remove, and keep them on
 * the trail when the trail is trimmed, merged or deleted.
 */

/**
 * The trail's live photos in time order, with what the read found: the UI
 * blocks edits (and says "made by a newer version") unless the status is
 * `ok` or `missing`.
 */
export async function readTrailPhotos(
  trackId: string,
): Promise<{ status: SidecarStatus; photos: TrackPhoto[] }> {
  const { status, sidecar } = await readSidecar(trackId);
  return { status, photos: orderPhotos(livePhotos(sidecar.photos)) };
}

/** The trail's live photos in time order (the viewer's order). */
export async function loadTrailPhotos(trackId: string): Promise<TrackPhoto[]> {
  const { sidecar } = await readSidecar(trackId);
  return orderPhotos(livePhotos(sidecar.photos));
}

/** Caption / hide / move one photo. Resolves to the updated photo, or null if it is gone. */
export async function editTrailPhoto(
  trackId: string,
  photoId: string,
  patch: { caption?: string; hidden?: boolean; position?: TrailPosition },
  now: number = Date.now(),
): Promise<TrackPhoto | null> {
  let updated: TrackPhoto | null = null;
  await updateSidecar(trackId, (sidecar) => {
    const photos = sidecar.photos.map((p) => {
      if (p.id !== photoId || p.deletedAt !== undefined) return p;
      updated = editPhoto(p, patch, now);
      return updated;
    });
    return updated ? { ...sidecar, photos } : sidecar;
  });
  return updated;
}

/** "Remove from trail": the record becomes a tombstone (team mode), the files go now. */
export async function removeTrailPhoto(
  trackId: string,
  photoId: string,
  now: number = Date.now(),
): Promise<boolean> {
  let removed: TrackPhoto | undefined;
  await updateSidecar(trackId, (sidecar) => {
    removed = sidecar.photos.find((p) => p.id === photoId && p.deletedAt === undefined);
    if (!removed) return sidecar;
    return {
      ...sidecar,
      photos: sidecar.photos.map((p) => (p.id === photoId ? tombstone(p, now) : p)),
    };
  });
  if (!removed) return false;
  deletePhotoFiles(removed);
  return true;
}

/** The trail was deleted: its photos go with it (the confirm dialog says how many). */
export function deleteTrailWithPhotos(trackId: string): void {
  deleteTrailPhotos(trackId);
}

/** How many photos a trail has, for "Delete trail and its 33 photos?". */
export async function trailPhotoCount(trackId: string): Promise<number> {
  return (await loadTrailPhotos(trackId)).length;
}

/**
 * The trail was trimmed to `[keptStartM, keptEndM]` of its old length and now
 * has `trimmedPoints`. Photos on the cut parts are removed (files and all);
 * the rest move to their new distance. Returns how many were removed.
 */
export async function onTrailTrimmed(
  trackId: string,
  keptStartM: number,
  keptEndM: number,
  trimmedPoints: readonly TrackPoint[],
  now: number = Date.now(),
): Promise<number> {
  const index = indexTrack(trimmedPoints);
  let removed: TrackPhoto[] = [];
  await updateSidecar(trackId, (sidecar) => {
    const r = reanchorAfterTrim(sidecar.photos, keptStartM, keptEndM, index, now);
    removed = r.removed;
    if (removed.length === 0 && r.kept.every((p, i) => p === sidecar.photos[i])) return sidecar;
    return { ...sidecar, photos: [...r.kept, ...removed.map((p) => tombstone(p, now))] };
  });
  for (const p of removed) deletePhotoFiles(p);
  return removed.length;
}

export interface MergeCopyResult {
  /** Photos copied onto the merged trail. */
  copied: number;
  /** Source trails whose photo list could not be read (left out, untouched). */
  skippedTrails: string[];
}

/**
 * Several trails were merged into a NEW trail `targetId` (with
 * `mergedPoints`). The Library keeps the originals, so their photos are
 * COPIED, under fresh ids (ids are global for team mode, #589), and re-placed
 * on the merged trail (by time, then GPS, then their old distance). Like the
 * merge's note photos (#304), the merged trail owns its copies outright:
 * deleting either it or a source never strands the other.
 *
 * A source whose sidecar cannot be read safely (corrupt, or from a newer app)
 * is left out and reported, never half-copied. Copies made before a failure
 * are removed again.
 */
export async function onTrailsMerged(
  sourceIds: readonly string[],
  targetId: string,
  mergedPoints: readonly TrackPoint[],
  newId: () => string,
  now: number = Date.now(),
): Promise<MergeCopyResult> {
  const index = indexTrack(mergedPoints);
  await readWritableSidecar(targetId);
  const result: MergeCopyResult = { copied: 0, skippedTrails: [] };
  const copies: TrackPhoto[] = [];
  try {
    for (const sourceId of sourceIds) {
      if (sourceId === targetId) continue;
      const { status, sidecar } = await readSidecar(sourceId);
      if (!sidecarWritable(status)) {
        result.skippedTrails.push(sourceId);
        continue;
      }
      for (const p of livePhotos(sidecar.photos))
        copies.push(await copyFiles(p, targetId, newId()));
    }
    if (copies.length === 0) return result;
    await updateSidecar(targetId, (sidecar) => ({
      ...sidecar,
      photos: [...sidecar.photos, ...reanchorOnTrail(copies, index, targetId, now)],
    }));
  } catch (err) {
    for (const p of copies) deletePhotoFiles(p);
    throw err;
  }
  result.copied = copies.length;
  return result;
}

/** Copy one photo's files into another trail's folder under a new id. */
async function copyFiles(photo: TrackPhoto, targetId: string, id: string): Promise<TrackPhoto> {
  const dest = photoFilePaths(targetId, id);
  const dir = new Directory(resolveDocumentPath(trailPhotoDir(targetId)));
  if (!dir.exists) dir.create({ intermediates: true });
  const copied: TrackPhoto = { ...photo, ...dest, id, trackId: targetId };
  try {
    for (const key of ['file', 'thumb', 'sprite'] as const) {
      const from = new File(resolveDocumentPath(photo[key]));
      if (from.exists) await from.copy(new File(resolveDocumentPath(dest[key])));
    }
  } catch (err) {
    deletePhotoFiles(copied);
    throw err;
  }
  return copied;
}

/**
 * Housekeeping for one trail (on idle): rewrite a sidecar that had unreadable
 * records, and delete copies nothing references. Returns files removed.
 * Does nothing at all unless the sidecar reads as `ok` or `missing`: with an
 * unreadable or newer-version sidecar every copy would look unreferenced.
 */
export async function tidyTrailPhotos(trackId: string, now: number = Date.now()): Promise<number> {
  const { status, sidecar, dropped } = await readSidecar(trackId);
  if (!sidecarWritable(status)) return 0;
  if (dropped > 0) writeSidecar(sidecar, now);
  return sweepTrailOrphans(trackId, new Set(livePhotos(sidecar.photos).map((p) => p.id)));
}
