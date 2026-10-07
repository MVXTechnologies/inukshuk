/**
 * Pins: comments anchored to a place (#589 UI). Pure.
 *
 * A pin is a message on the thread `pin:<id>` whose own id is `<id>` and which
 * carries `ll = [lng, lat]` (validated by `data.ts`); replies are messages on
 * the same thread. Guests may pin and reply (they "only comment").
 *
 * Two authors could post roots with the same id: the earliest (by creation
 * stamp, then author id) is the pin, so every phone shows the same place; any
 * other "root" reads as a reply.
 */
import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { compareStamp, type Stamp } from '@core/team/hlc';

export const PIN_THREAD_PREFIX = 'pin:';

export function pinThread(id: string): string {
  return `${PIN_THREAD_PREFIX}${id}`;
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

interface Raw {
  msg: PinMessage;
  stamp: Stamp;
  ll: [number, number] | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function anchor(v: Json | undefined): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lng, lat] = v;
  return finite(lng) && finite(lat) ? [lng, lat] : null;
}

/** Every live pin with its thread, newest activity first. */
export function teamPins(data: TeamData): TeamPin[] {
  const threads = new Map<string, Raw[]>();
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
    const raw: Raw = {
      msg: { id: rec.id, author: rec.owner, text: tx, at: rec.state.created.wall, mentions: mn },
      stamp: rec.state.created,
      ll: th === pinThread(rec.id) ? anchor(f['ll']) : null,
    };
    const list = threads.get(th);
    if (list) list.push(raw);
    else threads.set(th, [raw]);
  }
  const out: TeamPin[] = [];
  for (const [th, list] of threads) {
    const byStamp = (a: Raw, b: Raw) =>
      compareStamp(a.stamp, b.stamp) || (a.msg.author < b.msg.author ? -1 : 1);
    const root = list.filter((r) => r.ll !== null).sort(byStamp)[0];
    if (root === undefined || root.ll === null) continue; // replies to a redacted or unknown pin
    const rest = list.filter((r) => r !== root).sort(byStamp);
    const messages = [root, ...rest].map((r) => r.msg);
    out.push({
      id: th.slice(PIN_THREAD_PREFIX.length),
      owner: root.msg.author,
      lng: root.ll[0],
      lat: root.ll[1],
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
    const ex = ax + t * dx - px;
    const ey = ay + t * dy - py;
    best = Math.min(best, Math.hypot(ex, ey));
  }
  return best;
}

/** A pin closer than this to a shown trail reads as "on the trail". */
export const ON_TRAIL_M = 40;
