import { Directory, File } from 'expo-file-system';

import {
  emptySidecar,
  migratePhotoSidecar,
  type MigratedSidecar,
  type PhotoSidecar,
  type SidecarStatus,
} from '@core/photos/model';
import { sidecarPath, trailPhotoDir } from '@core/photos/paths';
import { pruneTombstones } from '@core/photos/record';
import { resolveDocumentPath, writeJson } from '@data/storage';

/**
 * Per-trail photo metadata (#587): `photos/<trackId>/photos.json`, written with
 * the same stage-then-promote JSON writer as `library.json` (a torn write
 * leaves a readable `.tmp`). Reads always go through `migratePhotoSidecar`,
 * so a corrupt or hand-edited file degrades to "no photos shown", never a
 * crash.
 *
 * Every read says what it found ({@link SidecarStatus}). Writes go ahead only
 * over a sidecar that was read whole (`ok`) or does not exist (`missing`):
 * an `unreadable` or `future` file is left exactly as it is and the write
 * fails with {@link SidecarUnavailableError}. Otherwise one torn file, or a
 * file from a newer app version, would be replaced by an empty photo list and
 * the orphan sweep would then delete every copy on the trail.
 *
 * Writes to one trail are serialized: an import appending every ten photos and
 * a caption edit from the viewer must not lose each other's changes.
 */

export type LoadedSidecar = MigratedSidecar;

/** A write was refused because the trail's sidecar could not be read safely. */
export class SidecarUnavailableError extends Error {
  readonly trackId: string;
  readonly status: Exclude<SidecarStatus, 'ok' | 'missing'>;
  constructor(trackId: string, status: Exclude<SidecarStatus, 'ok' | 'missing'>) {
    super(
      status === 'future'
        ? `The photos of trail ${trackId} were saved by a newer version of the app`
        : `The photo list of trail ${trackId} could not be read`,
    );
    this.name = 'SidecarUnavailableError';
    this.trackId = trackId;
    this.status = status;
  }
}

type RawRead = { kind: 'json'; value: unknown } | { kind: 'missing' } | { kind: 'corrupt' };

async function readJsonFile(file: File): Promise<RawRead> {
  if (!file.exists) return { kind: 'missing' };
  try {
    return { kind: 'json', value: JSON.parse(await file.text()) as unknown };
  } catch {
    return { kind: 'corrupt' };
  }
}

/**
 * The sidecar's JSON, telling "no file" from "a file we cannot parse". The
 * staged `.tmp` copy stands in for a torn or missing main file (a crash
 * between the JSON writer's delete and move leaves only the stage). A lone
 * unparseable stage with no main file is a first write that never landed:
 * there was never anything to lose, so it reads as missing.
 */
async function readRawSidecar(trackId: string): Promise<RawRead> {
  const path = sidecarPath(trackId);
  const main = await readJsonFile(new File(resolveDocumentPath(path)));
  if (main.kind === 'json') return main;
  const staged = await readJsonFile(new File(resolveDocumentPath(`${path}.tmp`)));
  if (staged.kind === 'json') return staged;
  return main.kind === 'corrupt' ? main : { kind: 'missing' };
}

export async function readSidecar(trackId: string): Promise<LoadedSidecar> {
  const raw = await readRawSidecar(trackId);
  if (raw.kind === 'corrupt')
    return { status: 'unreadable', sidecar: emptySidecar(trackId), dropped: 0 };
  return migratePhotoSidecar(raw.kind === 'json' ? raw.value : null, trackId);
}

/**
 * Read a sidecar that is about to be written over: throws
 * {@link SidecarUnavailableError} unless it is `ok` or `missing`.
 */
export async function readWritableSidecar(trackId: string): Promise<LoadedSidecar> {
  const loaded = await readSidecar(trackId);
  const { status } = loaded;
  if (status === 'unreadable' || status === 'future') {
    throw new SidecarUnavailableError(trackId, status);
  }
  return loaded;
}

/**
 * Write a trail's sidecar as is. Low level: callers must have read it with
 * {@link readWritableSidecar} (or go through {@link updateSidecar}).
 */
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
 * returns the next sidecar (or the same object to skip the write). Rejects
 * with {@link SidecarUnavailableError}, without calling `change` or writing,
 * when the sidecar is unreadable or from a newer version.
 */
export function updateSidecar(
  trackId: string,
  change: (current: PhotoSidecar) => PhotoSidecar | Promise<PhotoSidecar>,
): Promise<PhotoSidecar> {
  const previous = queues.get(trackId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const { sidecar } = await readWritableSidecar(trackId);
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
