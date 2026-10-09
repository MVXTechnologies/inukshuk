/**
 * Pins: comments anchored to a place (#589 UI). Pure.
 *
 * A pin is a message on the thread `pin:<owner>:<id>` written by `<owner>`,
 * whose own id is `<id>` and which carries `ll = [lng, lat]` (`data.ts`
 * refuses an anchored message on any other thread, so nobody can root or move
 * someone else's pin; messages are immutable). Replies are messages on the
 * same thread from anyone, guests too (they "only comment").
 */
import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import { entityKey, type TeamData } from '@core/team/data';
import { compareStamp, type Stamp } from '@core/team/hlc';

export const PIN_THREAD_PREFIX = 'pin:';

export function pinThread(owner: string, id: string): string {
  return `${PIN_THREAD_PREFIX}${owner}:${id}`;
}

/** The owner and id a pin thread names, or null. */
export function parsePinThread(th: string): { owner: string; id: string } | null {
  const m = /^pin:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{1,64})$/.exec(th);
  return m ? { owner: m[1]!, id: m[2]! } : null;
}

export interface PinMessage {
  id: string;
  author: string;
  text: string;
  at: number;
  mentions: string[];
}

export interface TeamPin {
  id: string;
  owner: string;
  lng: number;
  lat: number;
  /** The pin's own message first, then the replies, oldest first. */
  messages: PinMessage[];
  /** Newest message time. */
  lastAt: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function anchor(v: Json | undefined): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lng, lat] = v;
  return finite(lng) && finite(lat) ? [lng, lat] : null;
}

/** Every live pin with its thread, newest activity first. */
export function teamPins(data: TeamData): TeamPin[] {
  const threads = new Map<string, { msg: PinMessage; stamp: Stamp }[]>();
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'msg' || rec.owner === undefined || rec.state.created === undefined) continue;
    if (!isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    const th = f['th'];
    const tx = f['tx'];
    if (typeof th !== 'string' || !th.startsWith(PIN_THREAD_PREFIX) || typeof tx !== 'string')
      continue;
    const mn = Array.isArray(f['mn'])
      ? f['mn'].filter((m): m is string => typeof m === 'string')
      : [];
    const item = {
      msg: { id: rec.id, author: rec.owner, text: tx, at: rec.state.created.wall, mentions: mn },
      stamp: rec.state.created,
    };
    const list = threads.get(th);
    if (list) list.push(item);
    else threads.set(th, [item]);
  }
  const out: TeamPin[] = [];
  for (const [th, list] of threads) {
    const named = parsePinThread(th);
    if (named === null) continue;
    // The root is the owner's own message with the pin's id (msg keys are owned: one at most).
    const rootRec = data.entities.get(entityKey('msg', named.id, named.owner));
    if (rootRec === undefined || !isLive(rootRec.state)) continue;
    const ll = anchor(visibleFields(rootRec.state)['ll']);
    if (ll === null) continue;
    const ordered = [...list].sort(
      (a, b) => compareStamp(a.stamp, b.stamp) || (a.msg.author < b.msg.author ? -1 : 1),
    );
    const root = ordered.find((x) => x.msg.author === named.owner && x.msg.id === named.id);
    if (root === undefined) continue;
    const messages = [root, ...ordered.filter((x) => x !== root)].map((x) => x.msg);
    out.push({
      id: named.id,
      owner: named.owner,
      lng: ll[0],
      lat: ll[1],
      messages,
      lastAt: Math.max(...messages.map((m) => m.at)),
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt || (a.id < b.id ? -1 : 1));
}

/** Messages newer than `seenAt` not written by me (the pin's "new" count). */
export function unseenCount(
  messages: readonly { author: string; at: number }[],
  me: string,
  seenAt: number,
): number {
  return messages.filter((m) => m.author !== me && m.at > seenAt).length;
}

/** Distance in metres from a point to a polyline (`[lng, lat]` pairs); Infinity when empty. */
export function distanceToLine(
  lng: number,
  lat: number,
  line: readonly (readonly [number, number])[],
): number {
  const k = 111_320;
  const cos = Math.cos((lat * Math.PI) / 180);
  const px = lng * k * cos;
  const py = lat * k;
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1] ?? a;
    const ax = a[0] * k * cos;
    const ay = a[1] * k;
    const dx = b[0] * k * cos - ax;
    const dy = b[1] * k - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}

/** A pin closer than this to a shown trail reads as "on the trail". */
export const ON_TRAIL_M = 40;

/** `owner:id` of every message marked resolved (`mres`, res = true). */
export function resolvedMessages(data: TeamData): Set<string> {
  const out = new Set<string>();
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'mres' || rec.owner === undefined || !isLive(rec.state)) continue;
    if (visibleFields(rec.state)['res'] === true) out.add(`${rec.owner}:${rec.id}`);
  }
  return out;
}

/** Whether `me` may resolve a message: its author, an admin, or someone it mentions. */
export function canResolve(
  msg: { author: string; mentions: readonly string[] },
  me: string,
  admin: boolean,
): boolean {
  return msg.author === me || admin || msg.mentions.includes(me);
}
