import { Directory, File } from 'expo-file-system';

import type { TrackPoint } from '@core/models';
import { livePhotos, sidecarWritable, type TrackPhoto } from '@core/photos/model';
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

/**
 * Several trails were merged into `targetId` (with `mergedPoints`): their
 * photos move into the target's folder and are re-placed on the merged trail
 * (by time, then GPS, then their old distance). The sources' folders are
 * removed afterwards. Returns how many photos moved.
 */
export async function onTrailsMerged(
  sourceIds: readonly string[],
  targetId: string,
  mergedPoints: readonly TrackPoint[],
  now: number = Date.now(),
): Promise<number> {
  const index = indexTrack(mergedPoints);
  // Every sidecar involved must be readable BEFORE a single file moves: a
  // source we cannot read would have its folder deleted below with its photos
  // still in it, and a target we cannot write would strand the moved copies.
  await readWritableSidecar(targetId);
  const sources: TrackPhoto[][] = [];
  for (const sourceId of sourceIds) {
    if (sourceId === targetId) continue;
    sources.push(livePhotos((await readWritableSidecar(sourceId)).sidecar.photos));
  }
  const moving: TrackPhoto[] = [];
  for (const photos of sources) for (const p of photos) moving.push(moveFiles(p, targetId));
  await updateSidecar(targetId, (sidecar) => ({
    ...sidecar,
    photos: [
      ...reanchorOnTrail(sidecar.photos, index, targetId, now),
      ...reanchorOnTrail(moving, index, targetId, now),
    ],
  }));
  for (const sourceId of sourceIds) if (sourceId !== targetId) deleteTrailPhotos(sourceId);
  return moving.length;
}

/** Move one photo's copies into another trail's folder; returns it with the new paths. */
function moveFiles(photo: TrackPhoto, targetId: string): TrackPhoto {
  const dest = photoFilePaths(targetId, photo.id);
  const dir = new Directory(resolveDocumentPath(trailPhotoDir(targetId)));
  if (!dir.exists) dir.create({ intermediates: true });
  for (const key of ['file', 'thumb', 'sprite'] as const) {
    const from = new File(resolveDocumentPath(photo[key]));
    if (from.exists) from.moveSync(new File(resolveDocumentPath(dest[key])), { overwrite: true });
  }
  return { ...photo, ...dest, trackId: targetId };
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
