import type { TrackPoint } from '@core/models';
import { normalizeExif, resolveTakenAt, type ZoneOffsetAt } from '@core/photos/exif';
import type { PhotoAuthor, PhotoPlacement, TakenAtSource, TrackPhoto } from '@core/photos/model';
import {
  placeForced,
  planPhotoImport,
  type ImportCandidate,
  type ImportPlan,
  type PlannedPhoto,
} from '@core/photos/placement';
import { existingKeys, newTrackPhoto, sourceKeyFor } from '@core/photos/record';
import { ESTIMATED_BYTES_PER_PHOTO } from '@core/photos/resize';
import { indexTrack, type TrackIndex, type TrailPosition } from '@core/photos/trackIndex';
import { assessFreeSpaceForWrite } from '@data/diskSpace';
import { StorageFullError } from '@data/storage';

import {
  deletePhotoFiles,
  pickedFingerprint,
  writeFullSizeCopies,
  writePhotoCopies,
  type WrittenCopies,
} from './photoFiles';
import type { PhotoResizer, ResizedPhoto } from './resizer';
import { readWritableSidecar, updateSidecar } from './sidecarStore';

/**
 * Add photos from the phone's library to a trail (#587).
 *
 * Two steps, matching the Add-photos sheet:
 *
 * 1. {@link preparePhotoImport} — pure work on what the picker returned
 *    (`expo-image-picker` with `allowsMultipleSelection`, `exif: true`): read
 *    each EXIF, resolve its time in the device's zone, check the camera clock,
 *    place every photo, sort them into "by time" / "by location" / "not from
 *    this outing", and flag the ones already on the trail.
 * 2. {@link commitPhotoImport} — for the photos the user kept: check the disk,
 *    make the copies one by one, append to the trail's sidecar every few
 *    photos (an interrupted import keeps what it finished), report progress.
 */

/** The fields of an `ImagePickerAsset` this pipeline reads. */
export interface PickedPhoto {
  uri: string;
  assetId?: string | null;
  exif?: Record<string, unknown> | null;
  width?: number;
  height?: number;
}

export interface PreparedItem {
  picked: PickedPhoto;
  candidate: ImportCandidate;
  takenAtSource?: TakenAtSource;
  sourceKey?: string;
  /** Already on this trail (same asset, or same shot): skipped on commit. */
  duplicate: boolean;
}

export interface PreparedImport {
  trackId: string;
  index: TrackIndex;
  plan: ImportPlan;
  items: Map<string, PreparedItem>;
  /** How many picks are already on the trail. */
  duplicates: number;
}

/** The device zone's offset at an instant, in minutes east of UTC. */
export const deviceZoneOffsetAt: ZoneOffsetAt = (ms) => -new Date(ms).getTimezoneOffset();

export async function preparePhotoImport(args: {
  trackId: string;
  points: readonly TrackPoint[];
  picked: readonly PickedPhoto[];
  zoneOffsetAt?: ZoneOffsetAt;
  /** The user's Adjust value; omitted = estimate the camera clock. */
  manualClockOffsetMs?: number;
}): Promise<PreparedImport> {
  const zoneOffsetAt = args.zoneOffsetAt ?? deviceZoneOffsetAt;
  // Fails early (SidecarUnavailableError) when the commit could not write anyway.
  const { sidecar } = await readWritableSidecar(args.trackId);
  const known = existingKeys(sidecar.photos);
  const items = new Map<string, PreparedItem>();
  const candidates: ImportCandidate[] = [];
  let duplicates = 0;
  // What each picked file actually is (size + a hash of its first bytes):
  // two different shots from the same second must never share a key.
  const fingerprints: (string | undefined)[] = [];
  for (const picked of args.picked) fingerprints.push(pickedFingerprint(picked.uri));
  // Keys seen in this batch: the same photo picked twice is added once.
  const inBatch = new Set<string>();
  args.picked.forEach((picked, i) => {
    const key = `pick-${i}`;
    const exif = normalizeExif(picked.exif);
    const candidate: ImportCandidate = { key };
    const item: PreparedItem = { picked, candidate, duplicate: false };
    if (exif.time) {
      const resolved = resolveTakenAt(exif.time, zoneOffsetAt);
      candidate.takenAt = resolved.epochMs;
      item.takenAtSource = resolved.source;
    }
    if (exif.lngLat) candidate.lngLat = exif.lngLat;
    if (exif.camera) candidate.camera = exif.camera;
    const keyInput: Parameters<typeof sourceKeyFor>[0] = {
      assetId: picked.assetId,
      exifWallClock: exif.wallClock,
      width: exif.width ?? picked.width,
      height: exif.height ?? picked.height,
    };
    if (exif.camera) keyInput.camera = exif.camera;
    const fingerprint = fingerprints[i];
    if (fingerprint) keyInput.fingerprint = fingerprint;
    const sourceKey = sourceKeyFor(keyInput);
    if (sourceKey) {
      item.sourceKey = sourceKey;
      if (known.has(sourceKey) || inBatch.has(sourceKey)) {
        item.duplicate = true;
        duplicates++;
      }
      inBatch.add(sourceKey);
    }
    items.set(key, item);
    if (!item.duplicate) candidates.push(candidate);
  });
  const index = indexTrack(args.points);
  const plan = planPhotoImport(
    index,
    candidates,
    args.manualClockOffsetMs === undefined ? {} : { manualClockOffsetMs: args.manualClockOffsetMs },
  );
  return { trackId: args.trackId, index, plan, items, duplicates };
}

/** The keys checked by default: everything placed by time or by location. */
export function defaultSelection(prepared: PreparedImport): Set<string> {
  return new Set([...prepared.plan.byTime, ...prepared.plan.byGps].map((p) => p.candidate.key));
}

export interface CommitProgress {
  done: number;
  total: number;
}

export interface CommitResult {
  added: TrackPhoto[];
  failed: { key: string; message: string }[];
  /** The import stopped early (cancel or full disk); `added` is what was kept. */
  stopped?: 'cancelled' | 'storage-full';
}

/** Placement of one kept photo: its planned spot, or (an outsider ticked anyway) a forced one. */
function finalPlacement(
  prepared: PreparedImport,
  planned: PlannedPhoto,
  fallbackDistanceM: number,
): { placement: PhotoPlacement; position: TrailPosition; takenAt?: number } | null {
  const { result, candidate } = planned;
  if (result.kind === 'time') {
    return { placement: 'time', position: result.position, takenAt: result.takenAt };
  }
  const corrected =
    candidate.takenAt === undefined ? undefined : candidate.takenAt + planned.clockOffsetMs;
  if (result.kind === 'gps') {
    return corrected === undefined
      ? { placement: 'gps', position: result.position }
      : { placement: 'gps', position: result.position, takenAt: corrected };
  }
  const forced = placeForced(prepared.index, candidate, fallbackDistanceM);
  if (!forced) return null;
  return corrected === undefined ? forced : { ...forced, takenAt: corrected };
}

/** Make one photo's copies: optimized, or the stripped original when "Full size" is on and it is a JPEG. */
async function writeCopies(
  trackId: string,
  id: string,
  sourceUri: string,
  resized: ResizedPhoto,
  fullSize: boolean,
): Promise<{ copies: WrittenCopies; fullSize: boolean }> {
  const small = { thumb: resized.thumb.base64, sprite: resized.sprite.base64 };
  if (fullSize) {
    try {
      return { copies: await writeFullSizeCopies(trackId, id, sourceUri, small), fullSize: true };
    } catch (err) {
      if (err instanceof StorageFullError) throw err;
      // Not a JPEG (HEIC/PNG): keep the optimized copy instead.
    }
  }
  return {
    copies: writePhotoCopies(trackId, id, { display: resized.display.base64, ...small }),
    fullSize: false,
  };
}

export async function commitPhotoImport(args: {
  prepared: PreparedImport;
  /** Candidate keys the user kept (see {@link defaultSelection}). */
  selected: ReadonlySet<string>;
  resizer: PhotoResizer;
  newId: () => string;
  now?: () => number;
  /** Where a ticked outsider without GPS goes (the profile cursor). */
  fallbackDistanceM?: number;
  /** Keep the picked JPEG (metadata stripped) instead of the 2048 px copy. */
  fullSize?: boolean;
  author?: PhotoAuthor;
  /** Sidecar flushes during the import. */
  flushEvery?: number;
  onProgress?: (p: CommitProgress) => void;
  isCancelled?: () => boolean;
}): Promise<CommitResult> {
  const { prepared, resizer } = args;
  const now = args.now ?? Date.now;
  const flushEvery = args.flushEvery ?? 10;
  const all = [...prepared.plan.byTime, ...prepared.plan.byGps, ...prepared.plan.outside];
  const chosen = all.filter((p) => args.selected.has(p.candidate.key));
  const result: CommitResult = { added: [], failed: [] };
  if (chosen.length === 0) return result;
  // Before any copy is made: an unreadable or newer sidecar must not be written over.
  await readWritableSidecar(prepared.trackId);

  const disk = assessFreeSpaceForWrite(chosen.length * ESTIMATED_BYTES_PER_PHOTO);
  if (disk?.verdict === 'block') throw new StorageFullError(disk.message ?? 'disk full');

  let unsaved: TrackPhoto[] = [];
  const flush = async () => {
    if (unsaved.length === 0) return;
    const batch = unsaved;
    unsaved = [];
    try {
      await updateSidecar(prepared.trackId, (sidecar) => ({
        ...sidecar,
        photos: [...sidecar.photos, ...batch],
      }));
    } catch (err) {
      // The copies exist but the sidecar could not record them: remove them
      // rather than leave invisible files behind, and fail the import.
      for (const p of batch) deletePhotoFiles(p);
      const kept = new Set(batch.map((p) => p.id));
      result.added = result.added.filter((p) => !kept.has(p.id));
      throw err;
    }
  };

  for (let i = 0; i < chosen.length; i++) {
    args.onProgress?.({ done: i, total: chosen.length });
    if (args.isCancelled?.()) {
      result.stopped = 'cancelled';
      break;
    }
    const planned = chosen[i]!;
    const item = prepared.items.get(planned.candidate.key);
    const spot = finalPlacement(prepared, planned, args.fallbackDistanceM ?? 0);
    if (!item || !spot) {
      result.failed.push({ key: planned.candidate.key, message: 'could not place the photo' });
      continue;
    }
    const id = args.newId();
    try {
      const resized = await resizer.resize(item.picked.uri);
      const { copies, fullSize } = await writeCopies(
        prepared.trackId,
        id,
        item.picked.uri,
        resized,
        !!args.fullSize,
      );
      const input: Parameters<typeof newTrackPhoto>[0] = {
        id,
        trackId: prepared.trackId,
        position: spot.position,
        placement: spot.placement,
        paths: copies.paths,
        width: fullSize ? resized.sourceWidth : resized.display.width,
        height: fullSize ? resized.sourceHeight : resized.display.height,
        bytes: copies.bytes,
        now: now(),
      };
      if (spot.takenAt !== undefined) input.takenAt = spot.takenAt;
      if (item.takenAtSource) input.takenAtSource = item.takenAtSource;
      if (planned.clockOffsetMs !== 0 && planned.candidate.takenAt !== undefined) {
        input.clockOffsetMs = planned.clockOffsetMs;
      }
      if (copies.contentHash) input.contentHash = copies.contentHash;
      if (item.sourceKey) input.sourceKey = item.sourceKey;
      if (args.author) input.author = args.author;
      const photo = newTrackPhoto(input);
      result.added.push(photo);
      unsaved.push(photo);
    } catch (err) {
      if (err instanceof StorageFullError) {
        result.stopped = 'storage-full';
        break;
      }
      result.failed.push({
        key: planned.candidate.key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (unsaved.length >= flushEvery) await flush();
  }
  await flush();
  args.onProgress?.({ done: chosen.length, total: chosen.length });
  return result;
}
