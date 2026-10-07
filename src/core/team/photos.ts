import {
  sanitizePhoto,
  type PhotoAuthor,
  type PhotoComment,
  type TrackPhoto,
} from '@core/photos/model';

import type { Json } from './canonical';
import { isLive, lastWrite, visibleFields } from './crdt';
import type { EntityRecord } from './data';

/**
 * Bridge between the photos model (`@core/photos/model`, #587) and team
 * entities (#589). The photos model was built for this: global nanoid ids,
 * `createdAt`/`updatedAt` LWW, `deletedAt` tombstones, optional author, a
 * content hash. The mapping:
 *
 * | TrackPhoto | team entity `photo` (owned) |
 * |---|---|
 * | `id` | entity id |
 * | `author` | owner member id + their display name |
 * | `createdAt` / `updatedAt` | oldest / newest field write (HLC wall ms) |
 * | `deletedAt` | tombstone wall ms, when the tombstone wins |
 * | `file` / `thumb` / `sprite` | **not synced** — device-local paths, supplied on read |
 * | `contentHash` | synced; the blob phase fetches bytes by hash |
 * | `sourceKey` | **not synced** (it names an asset in the sender's camera roll) |
 * | everything else | one LWW field each |
 *
 * Reading goes through `sanitizePhoto`, so a team record obeys exactly the
 * rules a sidecar record does.
 */
export const PHOTO_SYNC_FIELDS = [
  'trackId',
  'distanceM',
  'lngLat',
  'elevationM',
  'placement',
  'takenAt',
  'takenAtSource',
  'clockOffsetMs',
  'width',
  'height',
  'bytes',
  'contentHash',
  'caption',
  'hidden',
] as const;

/** The synced fields of a photo (for an `e.set` of kind `photo`). */
export function photoToFields(photo: TrackPhoto): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const name of PHOTO_SYNC_FIELDS) {
    const v = photo[name];
    if (v !== undefined) out[name] = v as Json;
  }
  return out;
}

/** Fields that changed between two versions of a photo (only those go in the op). */
export function changedPhotoFields(before: TrackPhoto, after: TrackPhoto): Record<string, Json> {
  const a = photoToFields(before);
  const b = photoToFields(after);
  const out: Record<string, Json> = {};
  for (const name of PHOTO_SYNC_FIELDS) {
    if (JSON.stringify(a[name]) !== JSON.stringify(b[name]) && b[name] !== undefined) {
      out[name] = b[name];
    }
  }
  return out;
}

export interface LocalPaths {
  file: string;
  thumb: string;
  sprite: string;
}

/**
 * A team photo entity as a {@link TrackPhoto}. `null` when it cannot be shown
 * (no position, wrong kind, or the bytes are not local yet — `paths`
 * undefined). Deleted photos come back with `deletedAt` set, like a sidecar
 * tombstone.
 */
export function entityToPhoto(
  rec: EntityRecord,
  authorName: string,
  paths: LocalPaths | undefined,
): TrackPhoto | null {
  if (rec.kind !== 'photo' || rec.owner === undefined || paths === undefined) return null;
  const live = isLive(rec.state);
  // A tombstone keeps its last known fields so it still sanitizes (like a sidecar tombstone).
  const f = live ? visibleFields(rec.state) : lastKnownFields(rec);
  if (typeof f['trackId'] !== 'string') return null;
  const created = rec.state.created?.wall ?? 0;
  const raw: Record<string, unknown> = {
    ...f,
    ...paths,
    id: rec.id,
    createdAt: created,
    updatedAt: lastWrite(rec.state)?.wall ?? created,
    author: { id: rec.owner, name: authorName } satisfies PhotoAuthor,
  };
  if (!live && rec.state.deleted !== undefined) raw['deletedAt'] = rec.state.deleted.wall;
  return sanitizePhoto(raw, f['trackId']);
}

function lastKnownFields(rec: EntityRecord): Record<string, Json> {
  return Object.fromEntries(Object.entries(rec.state.fields).map(([k, r]) => [k, r.value]));
}

/** A comment's synced fields. */
export function commentToFields(comment: PhotoComment): Record<string, Json> {
  const out: Record<string, Json> = { photoId: comment.photoId, text: comment.text };
  if (comment.mentions && comment.mentions.length > 0) out['mentions'] = comment.mentions;
  return out;
}

export function entityToComment(rec: EntityRecord, authorName: string): PhotoComment | null {
  if (rec.kind !== 'comment' || rec.owner === undefined || rec.state.created === undefined)
    return null;
  const src = isLive(rec.state) ? visibleFields(rec.state) : lastKnownFields(rec);
  if (typeof src['photoId'] !== 'string' || typeof src['text'] !== 'string') return null;
  const comment: PhotoComment = {
    id: rec.id,
    photoId: src['photoId'],
    author: { id: rec.owner, name: authorName },
    text: src['text'],
    createdAt: rec.state.created.wall,
    updatedAt: lastWrite(rec.state)?.wall ?? rec.state.created.wall,
  };
  const mentions = src['mentions'];
  if (Array.isArray(mentions)) {
    const ids = mentions.filter((m): m is string => typeof m === 'string');
    if (ids.length > 0) comment.mentions = ids;
  }
  if (!isLive(rec.state) && rec.state.deleted !== undefined)
    comment.deletedAt = rec.state.deleted.wall;
  return comment;
}
