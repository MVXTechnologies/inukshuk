import type { LngLat, TrackNote } from '@core/models';

/**
 * Photos on the trail (#587): the data model.
 *
 * A {@link TrackPhoto} is a photo anchored at a distance along one trail. The
 * app keeps its OWN copies (an optimized display JPEG, a square thumbnail and
 * a round map sprite, none carrying EXIF) under `photos/<trackId>/`, and the
 * metadata in a per-trail sidecar ({@link PhotoSidecar}) next to them — not in
 * `library.json`, which is written whole and loaded at launch.
 *
 * The shape is ready for the serverless team mode (#589): global ids,
 * `createdAt`/`updatedAt` for last-writer-wins, `deletedAt` tombstones, an
 * optional `author`, a content hash so a peer can skip bytes it already has,
 * and comments as their own collection keyed by `photoId`.
 */

/** How a photo got its place on the trail. */
export type PhotoPlacement =
  /** EXIF time → the interpolated position along the recording (the default). */
  | 'time'
  /** EXIF GPS projected onto the nearest point of the trail. */
  | 'gps'
  /** Taken with the in-app Photo button: the live fix at that moment. */
  | 'capture'
  /** Placed by hand (dragged on the profile or the map). */
  | 'manual';

/** Where a photo's `takenAt` came from, most to least trustworthy. */
export type TakenAtSource =
  /** `DateTimeOriginal` + `OffsetTimeOriginal` (EXIF 2.31; iOS exposes it). */
  | 'exif-offset'
  /**
   * `DateTimeOriginal` in the zone a fresh GPS stamp (UTC) implies, or the GPS
   * stamp alone when the file has no original time.
   */
  | 'exif-gps-utc'
  /** `DateTimeOriginal` read as the device's local wall-clock time then. */
  | 'exif-local'
  /** The in-app camera: the device clock at capture. */
  | 'capture';

/** Someone in a team (#589). Absent on a photo = the device owner. */
export interface PhotoAuthor {
  id: string;
  name: string;
}

export interface TrackPhoto {
  /** nanoid(12), globally unique — stable across devices for team mode. */
  id: string;
  trackId: string;
  /** Anchor on the trail, metres from the start. Everything on screen derives from it. */
  distanceM: number;
  /** The on-trail position at `distanceM`, cached for the map. */
  lngLat: LngLat;
  /** Trail elevation at `distanceM` (not the EXIF altitude), when the trail has one. */
  elevationM?: number;
  placement: PhotoPlacement;
  /** When the photo was taken, epoch ms UTC (after any clock adjustment). */
  takenAt?: number;
  takenAtSource?: TakenAtSource;
  /** The camera-clock correction applied to the EXIF time, ms (0 / absent = none). */
  clockOffsetMs?: number;
  /** Document-relative paths (never absolute: the iOS container moves, #247). */
  file: string;
  thumb: string;
  sprite: string;
  /** Pixel size of the display copy. */
  width: number;
  height: number;
  /** Bytes of all three files together. */
  bytes: number;
  /** `md5:<hex>` of the display copy — dedupe and sync. */
  contentHash?: string;
  /** Re-import dedupe key built from the source (asset id, else time + size). */
  sourceKey?: string;
  caption?: string;
  /** Kept on the trail but not drawn on the map. */
  hidden?: boolean;
  author?: PhotoAuthor;
  createdAt: number;
  updatedAt: number;
  /** Tombstone for sync: the files are deleted, the record stays until peers saw it. */
  deletedAt?: number;
}

/** A comment on a photo (team mode, #589). Reserved: not stored or shown in v1. */
export interface PhotoComment {
  id: string;
  photoId: string;
  author: PhotoAuthor;
  text: string;
  /** Author ids @mentioned in `text`. */
  mentions?: string[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** The current sidecar schema version. */
export const PHOTO_SIDECAR_VERSION = 1;

/** One trail's photo metadata: `photos/<trackId>/photos.json`. */
export interface PhotoSidecar {
  version: typeof PHOTO_SIDECAR_VERSION;
  trackId: string;
  photos: TrackPhoto[];
  /** Always empty in v1; the slot exists so a v1 file is already a #589 file. */
  comments: PhotoComment[];
}

export function emptySidecar(trackId: string): PhotoSidecar {
  return { version: PHOTO_SIDECAR_VERSION, trackId, photos: [], comments: [] };
}

/** Photos that are drawn and counted: not tombstoned. */
export function livePhotos(photos: readonly TrackPhoto[]): TrackPhoto[] {
  return photos.filter((p) => p.deletedAt === undefined);
}

const PLACEMENTS: readonly PhotoPlacement[] = ['time', 'gps', 'capture', 'manual'];
const TAKEN_SOURCES: readonly TakenAtSource[] = [
  'exif-offset',
  'exif-gps-utc',
  'exif-local',
  'capture',
];

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

function asLngLat(v: unknown): LngLat | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const [lng, lat] = v as unknown[];
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) return undefined;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return undefined;
  return [lng, lat];
}

function asAuthor(v: unknown): PhotoAuthor | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const { id, name } = v as Record<string, unknown>;
  return isNonEmptyString(id) && typeof name === 'string' ? { id, name } : undefined;
}

/**
 * Validate one persisted photo record. Returns null for anything that cannot be
 * drawn (no id, no files, no position) — a torn or hand-edited sidecar must not
 * crash the trail view. Unknown fields are dropped; optional fields with a bad
 * type are dropped individually.
 *
 * The photo's raw EXIF position is deliberately NOT part of the record: it is
 * used once, at import, to place the photo and check the camera clock, and is
 * never stored, synced or exported. Only the on-trail position is kept (an
 * `exifLngLat` an early stage-1 build wrote is dropped here as unknown).
 */
export function sanitizePhoto(raw: unknown, trackId: string): TrackPhoto | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lngLat = asLngLat(r['lngLat']);
  if (
    !isNonEmptyString(r['id']) ||
    !isFiniteNumber(r['distanceM']) ||
    lngLat === undefined ||
    !isNonEmptyString(r['file']) ||
    !isNonEmptyString(r['thumb']) ||
    !isNonEmptyString(r['sprite'])
  ) {
    return null;
  }
  const placement = PLACEMENTS.includes(r['placement'] as PhotoPlacement)
    ? (r['placement'] as PhotoPlacement)
    : 'manual';
  const createdAt = isFiniteNumber(r['createdAt']) ? r['createdAt'] : 0;
  const photo: TrackPhoto = {
    id: r['id'],
    trackId,
    distanceM: Math.max(0, r['distanceM']),
    lngLat,
    placement,
    file: r['file'],
    thumb: r['thumb'],
    sprite: r['sprite'],
    width: isFiniteNumber(r['width']) ? r['width'] : 0,
    height: isFiniteNumber(r['height']) ? r['height'] : 0,
    bytes: isFiniteNumber(r['bytes']) ? r['bytes'] : 0,
    createdAt,
    updatedAt: isFiniteNumber(r['updatedAt']) ? r['updatedAt'] : createdAt,
  };
  if (isFiniteNumber(r['elevationM'])) photo.elevationM = r['elevationM'];
  if (isFiniteNumber(r['takenAt'])) photo.takenAt = r['takenAt'];
  if (TAKEN_SOURCES.includes(r['takenAtSource'] as TakenAtSource)) {
    photo.takenAtSource = r['takenAtSource'] as TakenAtSource;
  }
  if (isFiniteNumber(r['clockOffsetMs']) && r['clockOffsetMs'] !== 0) {
    photo.clockOffsetMs = r['clockOffsetMs'];
  }
  if (isNonEmptyString(r['contentHash'])) photo.contentHash = r['contentHash'];
  if (isNonEmptyString(r['sourceKey'])) photo.sourceKey = r['sourceKey'];
  if (typeof r['caption'] === 'string' && r['caption'].trim() !== '') {
    photo.caption = r['caption'];
  }
  if (r['hidden'] === true) photo.hidden = true;
  const author = asAuthor(r['author']);
  if (author) photo.author = author;
  if (isFiniteNumber(r['deletedAt'])) photo.deletedAt = r['deletedAt'];
  return photo;
}

function sanitizeComment(raw: unknown): PhotoComment | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const author = asAuthor(r['author']);
  if (
    !isNonEmptyString(r['id']) ||
    !isNonEmptyString(r['photoId']) ||
    author === undefined ||
    typeof r['text'] !== 'string' ||
    !isFiniteNumber(r['createdAt'])
  ) {
    return null;
  }
  const comment: PhotoComment = {
    id: r['id'],
    photoId: r['photoId'],
    author,
    text: r['text'],
    createdAt: r['createdAt'],
    updatedAt: isFiniteNumber(r['updatedAt']) ? r['updatedAt'] : r['createdAt'],
  };
  if (Array.isArray(r['mentions'])) {
    const mentions = r['mentions'].filter(isNonEmptyString);
    if (mentions.length > 0) comment.mentions = mentions;
  }
  if (isFiniteNumber(r['deletedAt'])) comment.deletedAt = r['deletedAt'];
  return comment;
}

/**
 * What reading a trail's sidecar found:
 *
 * - `ok` — a sidecar this app understands (some records may still have been
 *   dropped, see `dropped`).
 * - `missing` — no sidecar at all: the trail has no photos yet.
 * - `unreadable` — a file is there but is not a sidecar (corrupt JSON, wrong
 *   shape). Its photos may still be recoverable by hand.
 * - `future` — written by a newer app version this one cannot read.
 *
 * Only `ok` and `missing` may be written over ({@link sidecarWritable}):
 * rewriting an `unreadable` or `future` file would replace the trail's real
 * photo list with an empty one, and an orphan sweep would then delete every
 * copy as unreferenced.
 */
export type SidecarStatus = 'ok' | 'missing' | 'unreadable' | 'future';

export interface MigratedSidecar {
  status: SidecarStatus;
  /** The readable content; empty unless `status` is `ok`. */
  sidecar: PhotoSidecar;
  /** Records that could not be read (logged by the caller). */
  dropped: number;
}

/** Whether a sidecar read with this status may be rewritten (or its folder swept). */
export function sidecarWritable(status: SidecarStatus): boolean {
  return status === 'ok' || status === 'missing';
}

/**
 * Read any persisted sidecar into the current schema. Total: never throws.
 * `null`/`undefined` (no file) is `missing`; anything that is not a sidecar
 * object is `unreadable`; a newer version is `future` and is not half-read.
 * Duplicate ids keep the most recently updated record, and `dropped` counts
 * records that could not be read, so the caller can log a torn file.
 */
export function migratePhotoSidecar(raw: unknown, trackId: string): MigratedSidecar {
  const sidecar = emptySidecar(trackId);
  if (raw === null || raw === undefined) return { status: 'missing', sidecar, dropped: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unreadable', sidecar, dropped: 0 };
  }
  const r = raw as Record<string, unknown>;
  // A newer app wrote this: leave it alone rather than half-read it.
  if (isFiniteNumber(r['version']) && r['version'] > PHOTO_SIDECAR_VERSION) {
    return {
      status: 'future',
      sidecar,
      dropped: Array.isArray(r['photos']) ? r['photos'].length : 0,
    };
  }
  const photosRaw = r['photos'] ?? [];
  const commentsRaw = r['comments'] ?? [];
  if (!Array.isArray(photosRaw) || !Array.isArray(commentsRaw)) {
    return { status: 'unreadable', sidecar, dropped: 0 };
  }
  let dropped = 0;
  const byId = new Map<string, TrackPhoto>();
  for (const item of photosRaw) {
    const photo = sanitizePhoto(item, trackId);
    if (!photo) {
      dropped++;
      continue;
    }
    const prev = byId.get(photo.id);
    if (!prev || photo.updatedAt >= prev.updatedAt) byId.set(photo.id, photo);
  }
  sidecar.photos = [...byId.values()];
  for (const item of commentsRaw) {
    const comment = sanitizeComment(item);
    if (comment) sidecar.comments.push(comment);
    else dropped++;
  }
  return { status: 'ok', sidecar, dropped };
}

/**
 * A trail note's photo seen as a {@link TrackPhoto}, so a trail shows ONE set
 * of photos in the same layer and viewer (owner Q9). Read-only: notes keep
 * their own model and storage; nothing is migrated. `lngLat` / `elevationM`
 * come from the caller (the trail position at the note's distance).
 */
export function noteToPhoto(
  note: TrackNote,
  trackId: string,
  at: { lngLat: LngLat; elevationM?: number },
): TrackPhoto | null {
  if (!note.photoUri) return null;
  const photo: TrackPhoto = {
    id: `note:${note.id}`,
    trackId,
    distanceM: note.distanceM,
    lngLat: at.lngLat,
    placement: 'manual',
    file: note.photoUri,
    thumb: note.photoUri,
    sprite: note.photoUri,
    width: 0,
    height: 0,
    bytes: 0,
    createdAt: note.createdAt,
    updatedAt: note.createdAt,
  };
  if (at.elevationM !== undefined) photo.elevationM = at.elevationM;
  if (note.text.trim() !== '') photo.caption = note.text;
  return photo;
}

/** True for the adapter's read-only note photos (they cannot be moved or deleted here). */
export function isNotePhoto(photo: Pick<TrackPhoto, 'id'>): boolean {
  return photo.id.startsWith('note:');
}
