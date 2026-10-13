/**
 * Shared trail photos and comments (#589 UI, with #587's photo model). Pure.
 *
 * - A shared trail's photos are owned `photo` entities (`@core/team/photos`:
 *   the synced fields, `trackId` = the shared trail's id), plus one extra field
 *   `tb`: the 240 px thumbnail as base64 JPEG, written in its own op so each
 *   op stays under the 32 KiB cap. Full-size copies stay on the sharer's phone
 *   in v1 (blob transfer is the protocol's stage 3).
 * - A comment on a photo is the core's owned `comment` entity (`PhotoComment`:
 *   `photoId`, `text`, `mentions`).
 * - A comment on a whole trail is a message on the thread `trail:<trackId>`
 *   (the thread syntax `data.ts` reserves; guests may comment too).
 */
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { entityToComment } from '@core/team/photos';

/** Base64 characters a thumbnail may take (≈ 15 KiB of JPEG; the op cap is 32 KiB). */
export const MAX_THUMB_B64 = 20_000;

export const TRAIL_THREAD_PREFIX = 'trail:';

export function trailThread(trackId: string): string {
  return `${TRAIL_THREAD_PREFIX}${trackId}`;
}

export interface TeamPhoto {
  id: string;
  owner: string;
  trackId: string;
  lng: number;
  lat: number;
  takenAt: number | null;
  caption: string | null;
  /** `data:image/jpeg;base64,…` once its thumbnail op arrived, else null. */
  thumbUri: string | null;
  width: number;
  height: number;
}

export interface TeamComment {
  id: string;
  author: string;
  /** The photo it is about, or null for a comment on the whole trail. */
  photoId: string | null;
  trackId: string;
  text: string;
  at: number;
  mentions: string[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every live shared photo, by trail, oldest first. */
export function teamPhotos(data: TeamData): TeamPhoto[] {
  const out: TeamPhoto[] = [];
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'photo' || rec.owner === undefined || !isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    const ll = f['lngLat'];
    if (typeof f['trackId'] !== 'string' || !Array.isArray(ll) || ll.length !== 2) continue;
    const [lng, lat] = ll;
    if (!finite(lng) || !finite(lat)) continue;
    const tb = f['tb'];
    out.push({
      id: rec.id,
      owner: rec.owner,
      trackId: f['trackId'],
      lng,
      lat,
      takenAt: finite(f['takenAt']) ? f['takenAt'] : null,
      caption: typeof f['caption'] === 'string' ? f['caption'] : null,
      thumbUri:
        typeof tb === 'string' && tb.length <= MAX_THUMB_B64 && /^[A-Za-z0-9+/=]+$/.test(tb)
          ? `data:image/jpeg;base64,${tb}`
          : null,
      width: finite(f['width']) ? f['width'] : 0,
      height: finite(f['height']) ? f['height'] : 0,
    });
  }
  return out.sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0) || (a.id < b.id ? -1 : 1));
}

/**
 * Comments on one shared trail (`owner`'s `trackId`): the trail's own thread
 * plus the comments on its photos, oldest first.
 */
export function trailComments(
  data: TeamData,
  trackId: string,
  photosOfTrail: ReadonlySet<string>,
): TeamComment[] {
  const out: TeamComment[] = [];
  const thread = trailThread(trackId);
  for (const rec of data.entities.values()) {
    if (rec.owner === undefined || rec.state.created === undefined || !isLive(rec.state)) continue;
    if (rec.kind === 'msg') {
      const f = visibleFields(rec.state);
      if (f['th'] !== thread || typeof f['tx'] !== 'string') continue;
      const mn = Array.isArray(f['mn'])
        ? f['mn'].filter((m): m is string => typeof m === 'string')
        : [];
      out.push({
        id: rec.id,
        author: rec.owner,
        photoId: null,
        trackId,
        text: f['tx'],
        at: rec.state.created.wall,
        mentions: mn,
      });
    } else if (rec.kind === 'comment') {
      const c = entityToComment(rec, '');
      if (c === null || c.deletedAt !== undefined || !photosOfTrail.has(c.photoId)) continue;
      out.push({
        id: c.id,
        author: c.author.id,
        photoId: c.photoId,
        trackId,
        text: c.text,
        at: c.createdAt,
        mentions: c.mentions ?? [],
      });
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Comments on one photo, wherever it is shared, oldest first. */
export function photoComments(data: TeamData, photoId: string): TeamComment[] {
  const out: TeamComment[] = [];
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'comment') continue;
    const c = entityToComment(rec, '');
    if (c === null || c.deletedAt !== undefined || c.photoId !== photoId) continue;
    out.push({
      id: c.id,
      author: c.author.id,
      photoId,
      trackId: '',
      text: c.text,
      at: c.createdAt,
      mentions: c.mentions ?? [],
    });
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Who owns a shared photo and which shared trail it is on (alerts, deep links). */
export function photoIndex(data: TeamData): Map<string, { owner: string; trackId: string }> {
  const out = new Map<string, { owner: string; trackId: string }>();
  for (const p of teamPhotos(data)) out.set(p.id, { owner: p.owner, trackId: p.trackId });
  return out;
}

/** Who shared a trail, by its id (trail-thread alerts, deep links). */
export function trailOwners(data: TeamData): Map<string, string> {
  const out = new Map<string, string>();
  for (const rec of data.entities.values()) {
    if (rec.kind === 'track' && rec.owner !== undefined && isLive(rec.state)) {
      out.set(rec.id, rec.owner);
    }
  }
  return out;
}
