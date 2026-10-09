/**
 * Team chat's sub-threads (#589, owner 2026-10-07): the conversations that
 * hang off a place rather than the general channel, one row each, newest
 * activity first. Pure, read from data the team already syncs (no new op):
 *
 * - a shared photo's comments (`comment` entities, seen as `photo:<id>`);
 * - a pinned message and its replies (`pin:<owner>:<id>`);
 * - a shared trail's own thread (`trail:<trackId>` messages; trail points'
 *   comments are messages on that thread).
 *
 * A photo without a comment, or a trail without a message, is no thread yet.
 */
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { entityToComment } from '@core/team/photos';

import { TRAIL_THREAD_PREFIX, type TeamPhoto } from './comments';
import { unseenCount, type TeamPin } from './pins';
import type { TeamTrack } from './shares';

export type ThreadTarget =
  | { kind: 'photo'; owner: string; trackId: string; photoId: string; at: [number, number] }
  | { kind: 'pin'; owner: string; id: string; at: [number, number] }
  | { kind: 'trail'; owner: string; trackId: string; at: [number, number] | null };

export interface ThreadRow {
  /** The thread key the seen-marks use (`photo:…`, `pin:…`, `trail:…`). */
  key: string;
  title: string;
  /** A photo thread's thumbnail (`data:` URI), else null. */
  thumbUri: string | null;
  count: number;
  /** Messages since I last looked, not mine. */
  unread: number;
  last: { author: string; text: string; at: number };
  /** Resolved pins sink below the open threads. */
  resolved: boolean;
  target: ThreadTarget;
}

export interface ThreadsInput {
  data: TeamData;
  me: string;
  photos: readonly TeamPhoto[];
  pins: readonly TeamPin[];
  tracks: readonly TeamTrack[];
  /** `owner:id` of resolved messages. */
  resolved: ReadonlySet<string>;
  seenAt: (thread: string) => number;
}

interface Line {
  author: string;
  text: string;
  at: number;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Every sub-thread with at least one message: open ones first, then newest first. */
export function teamThreads(input: ThreadsInput): ThreadRow[] {
  const { data, me, seenAt } = input;
  // One pass over the entities: photo comments and trail-thread messages.
  const byPhoto = new Map<string, Line[]>();
  const byTrail = new Map<string, Line[]>();
  for (const rec of data.entities.values()) {
    if (rec.owner === undefined || !isLive(rec.state)) continue;
    if (rec.kind === 'comment') {
      const c = entityToComment(rec, '');
      if (c === null || c.deletedAt !== undefined) continue;
      const list = byPhoto.get(c.photoId) ?? [];
      list.push({ author: c.author.id, text: c.text, at: c.createdAt });
      byPhoto.set(c.photoId, list);
    } else if (rec.kind === 'msg' && rec.state.created !== undefined) {
      const f = visibleFields(rec.state);
      const th = f['th'];
      if (typeof th !== 'string' || !th.startsWith(TRAIL_THREAD_PREFIX)) continue;
      if (typeof f['tx'] !== 'string') continue;
      const trackId = th.slice(TRAIL_THREAD_PREFIX.length);
      const list = byTrail.get(trackId) ?? [];
      list.push({ author: rec.owner, text: f['tx'], at: rec.state.created.wall });
      byTrail.set(trackId, list);
    }
  }
  const newest = (lines: Line[]) =>
    lines.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.text > a.text) ? b : a));
  const rows: ThreadRow[] = [];
  for (const p of input.photos) {
    const lines = byPhoto.get(p.id);
    if (!lines || lines.length === 0) continue;
    const key = `photo:${p.id}`;
    rows.push({
      key,
      title: p.caption ? short(p.caption, 60) : 'A shared photo',
      thumbUri: p.thumbUri,
      count: lines.length,
      unread: unseenCount(lines, me, seenAt(key)),
      last: newest(lines),
      resolved: false,
      target: {
        kind: 'photo',
        owner: p.owner,
        trackId: p.trackId,
        photoId: p.id,
        at: [p.lng, p.lat],
      },
    });
  }
  for (const p of input.pins) {
    const first = p.messages[0];
    if (!first) continue;
    const key = `pin:${p.owner}:${p.id}`;
    rows.push({
      key,
      title: short(first.text || 'A pinned message', 60),
      thumbUri: null,
      count: p.messages.length,
      unread: unseenCount(p.messages, me, seenAt(key)),
      last: newest(p.messages.map((m) => ({ author: m.author, text: m.text, at: m.at }))),
      resolved: input.resolved.has(`${p.owner}:${p.id}`),
      target: { kind: 'pin', owner: p.owner, id: p.id, at: [p.lng, p.lat] },
    });
  }
  const trackById = new Map(input.tracks.map((t) => [t.id, t]));
  for (const [trackId, lines] of byTrail) {
    const track = trackById.get(trackId);
    if (!track) continue;
    const key = `trail:${trackId}`;
    const start = track.parts[0]?.[0] ?? null;
    rows.push({
      key,
      title: short(track.name || 'A shared trail', 60),
      thumbUri: null,
      count: lines.length,
      unread: unseenCount(lines, me, seenAt(key)),
      last: newest(lines),
      resolved: false,
      target: {
        kind: 'trail',
        owner: track.owner,
        trackId,
        at: start ? [start[0], start[1]] : null,
      },
    });
  }
  return rows.sort(
    (a, b) =>
      Number(a.resolved) - Number(b.resolved) || b.last.at - a.last.at || (a.key < b.key ? -1 : 1),
  );
}

/** Unread messages across every sub-thread (open ones only). */
export function threadsUnread(rows: readonly ThreadRow[]): number {
  return rows.reduce((n, r) => n + (r.resolved ? 0 : r.unread), 0);
}
