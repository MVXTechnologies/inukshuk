import type { PhotoAuthor, PhotoPlacement, TakenAtSource, TrackPhoto } from './model';
import type { PhotoFilePaths } from './paths';
import type { TrailPosition } from './trackIndex';

/**
 * Build the persisted {@link TrackPhoto} for a photo whose copies have been
 * written (#587) — the last pure step of an import or an in-app capture.
 */
export interface NewPhotoInput {
  id: string;
  trackId: string;
  position: TrailPosition;
  placement: PhotoPlacement;
  /** The corrected capture time, if known. */
  takenAt?: number;
  takenAtSource?: TakenAtSource;
  clockOffsetMs?: number;
  paths: PhotoFilePaths;
  width: number;
  height: number;
  bytes: number;
  contentHash?: string;
  sourceKey?: string;
  caption?: string;
  author?: PhotoAuthor;
  now: number;
}

export function newTrackPhoto(input: NewPhotoInput): TrackPhoto {
  const photo: TrackPhoto = {
    id: input.id,
    trackId: input.trackId,
    distanceM: input.position.distanceM,
    lngLat: input.position.lngLat,
    placement: input.placement,
    file: input.paths.file,
    thumb: input.paths.thumb,
    sprite: input.paths.sprite,
    width: input.width,
    height: input.height,
    bytes: input.bytes,
    createdAt: input.now,
    updatedAt: input.now,
  };
  if (input.position.elevationM !== undefined) photo.elevationM = input.position.elevationM;
  if (input.takenAt !== undefined) photo.takenAt = input.takenAt;
  if (input.takenAtSource !== undefined) photo.takenAtSource = input.takenAtSource;
  if (input.clockOffsetMs) photo.clockOffsetMs = input.clockOffsetMs;
  if (input.contentHash) photo.contentHash = input.contentHash;
  if (input.sourceKey) photo.sourceKey = input.sourceKey;
  const caption = input.caption?.trim();
  if (caption) photo.caption = caption;
  if (input.author) photo.author = input.author;
  return photo;
}

/**
 * A re-import dedupe key for a picked photo: the platform asset id when the
 * picker gives one (stable across picks), else the camera's raw EXIF wall
 * clock with the pixel size (the same shot picked twice). The raw string, not
 * the resolved instant: an unzoned time is read in the device's CURRENT zone,
 * so the same shot would get a different instant after travel or a DST
 * switch. Undefined when neither is known — such a photo can't be recognised
 * again, so it is never skipped.
 */
export function sourceKeyFor(input: {
  assetId?: string | null;
  /** `NormalizedExif.wallClock`. */
  exifWallClock?: string;
  width?: number;
  height?: number;
}): string | undefined {
  if (input.assetId) return `asset:${input.assetId}`;
  if (input.exifWallClock && input.width && input.height) {
    return `shot:${input.exifWallClock}:${input.width}x${input.height}`;
  }
  return undefined;
}

/** Keys already on the trail — a re-picked photo is skipped, not duplicated. */
export function existingKeys(
  photos: readonly Pick<TrackPhoto, 'sourceKey' | 'contentHash' | 'deletedAt'>[],
): Set<string> {
  const keys = new Set<string>();
  for (const p of photos) {
    if (p.deletedAt !== undefined) continue;
    if (p.sourceKey) keys.add(p.sourceKey);
    if (p.contentHash) keys.add(p.contentHash);
  }
  return keys;
}

/** Edit a photo (caption, hidden, a manual move), bumping `updatedAt` for sync. */
export function editPhoto(
  photo: TrackPhoto,
  patch: { caption?: string; hidden?: boolean; position?: TrailPosition },
  now: number,
): TrackPhoto {
  const next: TrackPhoto = { ...photo, updatedAt: now };
  if (patch.caption !== undefined) {
    const c = patch.caption.trim();
    if (c) next.caption = c;
    else delete next.caption;
  }
  if (patch.hidden !== undefined) {
    if (patch.hidden) next.hidden = true;
    else delete next.hidden;
  }
  if (patch.position) {
    next.distanceM = patch.position.distanceM;
    next.lngLat = patch.position.lngLat;
    next.placement = 'manual';
    if (patch.position.elevationM !== undefined) next.elevationM = patch.position.elevationM;
    else delete next.elevationM;
  }
  return next;
}

/**
 * Remove a photo: its record becomes a tombstone (so team peers learn of the
 * delete, #589) and the caller deletes its files. Tombstones older than
 * `retainMs` are dropped from the sidecar entirely.
 */
export function tombstone(photo: TrackPhoto, now: number): TrackPhoto {
  const { caption: _caption, ...rest } = photo;
  return { ...rest, deletedAt: now, updatedAt: now };
}

export const TOMBSTONE_RETAIN_MS = 90 * 24 * 60 * 60_000;

export function pruneTombstones(
  photos: readonly TrackPhoto[],
  now: number,
  retainMs = TOMBSTONE_RETAIN_MS,
): TrackPhoto[] {
  return photos.filter((p) => p.deletedAt === undefined || now - p.deletedAt < retainMs);
}
