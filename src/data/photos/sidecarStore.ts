import { Directory } from 'expo-file-system';

import { migratePhotoSidecar, type PhotoSidecar } from '@core/photos/model';
import { sidecarPath, trailPhotoDir } from '@core/photos/paths';
import { pruneTombstones } from '@core/photos/record';
import { readJson, resolveDocumentPath, writeJson } from '@data/storage';

/**
 * Per-trail photo metadata (#587): `photos/<trackId>/photos.json`, written with
 * the same stage-then-promote JSON writer as `library.json` (a torn write
 * leaves a readable `.tmp`). Reads always go through `migratePhotoSidecar`,
 * so a corrupt or hand-edited file degrades to "fewer photos", never a crash.
 *
 * Writes to one trail are serialized: an import appending every ten photos and
 * a caption edit from the viewer must not lose each other's changes.
 */

export interface LoadedSidecar {
  sidecar: PhotoSidecar;
  /** Records that could not be read (logged by the caller). */
  dropped: number;
}

export async function readSidecar(trackId: string): Promise<LoadedSidecar> {
  return migratePhotoSidecar(await readJson<unknown>(sidecarPath(trackId)), trackId);
}

export function writeSidecar(sidecar: PhotoSidecar, now: number = Date.now()): void {
  const dir = new Directory(resolveDocumentPath(trailPhotoDir(sidecar.trackId)));
  if (!dir.exists) dir.create({ intermediates: true });
  writeJson(sidecarPath(sidecar.trackId), {
    ...sidecar,
    photos: pruneTombstones(sidecar.photos, now),
  });
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Read-modify-write one trail's sidecar, serialized per trail. `change`
 * returns the next sidecar (or the same object to skip the write).
 */
export function updateSidecar(
  trackId: string,
  change: (current: PhotoSidecar) => PhotoSidecar | Promise<PhotoSidecar>,
): Promise<PhotoSidecar> {
  const previous = queues.get(trackId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const { sidecar } = await readSidecar(trackId);
      const next = await change(sidecar);
      if (next !== sidecar) writeSidecar(next);
      return next;
    });
  queues.set(trackId, run);
  const settle = () => {
    if (queues.get(trackId) === run) queues.delete(trackId);
  };
  run.then(settle, settle);
  return run;
}
