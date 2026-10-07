import type { ArchiveHost } from '@core/geo/activityFiles';
import {
  boundedCollector,
  ImportLimitError,
  type ByteBudget,
} from '@core/geo/activityFiles/limits';
import { listZipEntries, pumpZipEntry, type ZipEntry } from '@core/geo/activityFiles/zip';
import type { TrackPoint } from '@core/models';
import type { TrackPhoto } from '@core/photos/model';
import { placeForced, planPhotoImport, type PlannedPhoto } from '@core/photos/placement';
import { newTrackPhoto } from '@core/photos/record';
import { indexTrack, type TrackIndex, type TrailPosition } from '@core/photos/trackIndex';
import {
  DEFAULT_ZIP_PHOTO_LIMITS,
  zipPhotoCandidate,
  zipPhotoCaption,
  type ZipPhotoAttach,
  type ZipPhotoLimits,
} from '@core/photos/zipImport';
import { deletePhotoFiles, writePhotoCopies } from '@data/photos/photoFiles';
import type { PhotoResizer } from '@data/photos/resizer';
import { updateSidecar } from '@data/photos/sidecarStore';
import { createImportSpillWriter, deleteFileAt, StorageFullError } from '@data/storage';
import { uuid } from 'expo-modules-core';

/**
 * Re-attach a "Trail + photos" zip's photos to the trail just imported from
 * it (#587). Per photo: read its entry (by name — a lookup key, nothing more)
 * through the import's decompression budget and the per-photo cap, stage the
 * bytes in the cache under a random uuid, make the app's own copies with the
 * resizer (a canvas re-encode: whatever metadata the file carried is gone),
 * and place it on the trail by the waypoint's time, then its position. The
 * staged file is deleted in a `finally`. Photos are recorded in the trail's
 * sidecar at the end; a failed record removes the copies it made.
 */

export interface ZipPhotoResult {
  added: number;
  failed: number;
}

export async function attachZipPhotos(args: {
  trackId: string;
  points: readonly TrackPoint[];
  attach: readonly ZipPhotoAttach[];
  /** The archive to read from, as the activity walker opened it. */
  zipRef: string;
  host: Pick<ArchiveHost, 'open' | 'yieldToUi'>;
  budget: ByteBudget;
  resizer: PhotoResizer;
  newId: () => string;
  limits?: ZipPhotoLimits;
  now?: () => number;
}): Promise<ZipPhotoResult> {
  const limits = args.limits ?? DEFAULT_ZIP_PHOTO_LIMITS;
  const now = args.now ?? Date.now;
  const result: ZipPhotoResult = { added: 0, failed: 0 };
  if (args.attach.length === 0) return result;

  const byName = new Map<string, ZipEntry>(
    args.host.open(args.zipRef, (src) => listZipEntries(src)).map((e) => [e.name, e]),
  );
  const byKey = new Map(args.attach.map((a) => [a.key, a]));
  const index = indexTrack(args.points);
  // Exported times are already corrected: no camera-clock estimate.
  const plan = planPhotoImport(index, args.attach.map(zipPhotoCandidate), {
    manualClockOffsetMs: 0,
  });
  const planned = [...plan.byTime, ...plan.byGps, ...plan.outside];

  const added: TrackPhoto[] = [];
  for (const p of planned) {
    const attach = byKey.get(p.candidate.key);
    const entry = attach && byName.get(attach.entryName);
    const spot = placementOf(index, p);
    if (!attach || !entry || !spot) {
      result.failed++;
      continue;
    }
    let staged: string | null = null;
    try {
      const bytes = await readEntry(args, entry, limits.maxPhotoBytes);
      const writer = createImportSpillWriter(`${uuid.v4()}.jpg`);
      staged = writer.uri;
      writer.write(bytes);
      writer.close();
      const resized = await args.resizer.resize(staged);
      const id = args.newId();
      const copies = writePhotoCopies(args.trackId, id, {
        display: resized.display.base64,
        thumb: resized.thumb.base64,
        sprite: resized.sprite.base64,
      });
      const input: Parameters<typeof newTrackPhoto>[0] = {
        id,
        trackId: args.trackId,
        position: spot.position,
        placement: spot.placement,
        paths: copies.paths,
        width: resized.display.width,
        height: resized.display.height,
        bytes: copies.bytes,
        now: now(),
      };
      if (spot.takenAt !== undefined) input.takenAt = spot.takenAt;
      if (copies.contentHash) input.contentHash = copies.contentHash;
      const caption = zipPhotoCaption(attach.waypoint);
      if (caption) input.caption = caption;
      added.push(newTrackPhoto(input));
    } catch (err) {
      result.failed++;
      // The disk is full, or the import's decompression budget is spent: stop here.
      if (
        err instanceof StorageFullError ||
        (err instanceof ImportLimitError && args.budget.exhausted)
      ) {
        break;
      }
    } finally {
      if (staged) {
        try {
          deleteFileAt(staged);
        } catch {
          // The cache: the OS reclaims it.
        }
      }
    }
  }

  if (added.length > 0) {
    try {
      await updateSidecar(args.trackId, (sidecar) => ({
        ...sidecar,
        photos: [...sidecar.photos, ...added],
      }));
    } catch (err) {
      for (const p of added) deletePhotoFiles(p);
      throw err;
    }
  }
  result.added = added.length;
  return result;
}

function placementOf(
  index: TrackIndex,
  p: PlannedPhoto,
): { placement: TrackPhoto['placement']; position: TrailPosition; takenAt?: number } | null {
  const { result, candidate } = p;
  if (result.kind === 'time') {
    return { placement: 'time', position: result.position, takenAt: result.takenAt };
  }
  const takenAt = candidate.takenAt;
  const at =
    result.kind === 'gps'
      ? { placement: 'gps' as const, position: result.position }
      : placeForced(index, candidate, 0);
  if (!at) return null;
  return takenAt === undefined ? at : { ...at, takenAt };
}

async function readEntry(
  args: { zipRef: string; host: Pick<ArchiveHost, 'open' | 'yieldToUi'>; budget: ByteBudget },
  entry: ZipEntry,
  maxBytes: number,
): Promise<Uint8Array> {
  if (entry.uncompressedSize > maxBytes) {
    throw new ImportLimitError(`${entry.name} is larger than the per-photo limit`);
  }
  const out = boundedCollector(maxBytes, args.budget);
  await pumpZipEntry(
    (fn) => args.host.open(args.zipRef, fn),
    entry,
    out.push,
    () => args.host.yieldToUi(),
  );
  return out.result();
}
