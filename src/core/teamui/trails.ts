/**
 * Team trails in the UI (#589, owner 2026-10-07: "editable by all members").
 * Pure: the trails with their live vertices, where a tap lands on one (a
 * vertex, or a segment to insert into), the keys an edit needs, and who is
 * editing (presence messages).
 */
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import {
  decodeLine,
  keyBetween,
  MAX_TRAIL_VERTICES,
  trailVertices,
  vertexTrail,
  type TrailVertex,
} from '@core/team/records';
import { compareStamp, type Stamp } from '@core/team/hlc';

export interface TeamTrailView {
  owner: string;
  id: string;
  name: string;
  desc: string;
  color: string | null;
  vertices: TrailVertex[];
  /** The recorded trail it was made from, if any (drawn instead of it). */
  src: { owner: string; id: string } | null;
}

/** Every live team trail with its current vertices. */
export function teamTrails(data: TeamData): TeamTrailView[] {
  const edits = new Map<string, { id: string; state: import('@core/team/crdt').EntityState }[]>();
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'tve' || rec.owner === undefined) continue;
    const tr = vertexTrail(rec.id);
    if (tr === null) continue;
    const key = `${rec.owner}:${tr}`;
    const list = edits.get(key);
    const e = { id: rec.id, state: rec.state };
    if (list) list.push(e);
    else edits.set(key, [e]);
  }
  const out: TeamTrailView[] = [];
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'trl' || rec.owner === undefined || !isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    const baseText = rec.state.fields['base']?.value;
    const base = typeof baseText === 'string' ? decodeLine(baseText, MAX_TRAIL_VERTICES) : null;
    if (base === null) continue;
    const so = f['so'];
    const si = f['si'];
    out.push({
      owner: rec.owner,
      id: rec.id,
      name: typeof f['name'] === 'string' ? f['name'] : 'Trail',
      desc: typeof f['desc'] === 'string' ? f['desc'] : '',
      color: typeof f['color'] === 'string' ? f['color'] : null,
      vertices: trailVertices(base, rec.id, rec.owner, edits.get(`${rec.owner}:${rec.id}`) ?? []),
      src: typeof so === 'string' && typeof si === 'string' ? { owner: so, id: si } : null,
    });
  }
  return out.sort((a, b) => (a.owner + a.id < b.owner + b.id ? -1 : 1));
}

const K = 111_320;
const toXY = (p: readonly [number, number], cos: number): [number, number] => [
  p[0] * K * cos,
  p[1] * K,
];

/** The vertex within `tolM` of a point, nearest first, or null. */
export function nearestVertex(
  vertices: readonly TrailVertex[],
  at: readonly [number, number],
  tolM: number,
): TrailVertex | null {
  const cos = Math.cos((at[1] * Math.PI) / 180);
  const [x, y] = toXY(at, cos);
  let best: TrailVertex | null = null;
  let bestD = tolM;
  for (const v of vertices) {
    const [vx, vy] = toXY([v.lng, v.lat], cos);
    const d = Math.hypot(vx - x, vy - y);
    if (d <= bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/** The segment within `tolM` (its index: between vertex i and i+1), and the point on it. */
export function nearestSegment(
  vertices: readonly TrailVertex[],
  at: readonly [number, number],
  tolM: number,
): { index: number; point: [number, number] } | null {
  const cos = Math.cos((at[1] * Math.PI) / 180);
  const [x, y] = toXY(at, cos);
  let best: { index: number; point: [number, number] } | null = null;
  let bestD = tolM;
  for (let i = 0; i + 1 < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    const [ax, ay] = toXY([a.lng, a.lat], cos);
    const [bx, by] = toXY([b.lng, b.lat], cos);
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(px - x, py - y);
    if (d <= bestD) {
      bestD = d;
      best = { index: i, point: [px / (K * cos), py / K] };
    }
  }
  return best;
}

/** The key for a vertex inserted after vertex `index` (-1: before the first), or null (no room). */
export function insertKey(vertices: readonly TrailVertex[], index: number): string | null {
  const before = index >= 0 ? (vertices[index]?.key ?? null) : null;
  const after = vertices[index + 1]?.key ?? null;
  return keyBetween(before, after);
}

// ── Presence ───────────────────────────────────────────────────────────────

export const SYS_EDIT = 'sys:edit';
/** An "editing" mark is fresh this long. */
export const EDIT_PRESENCE_MS = 2 * 60_000;

export function editText(trail: string | null): string {
  return JSON.stringify({ t: trail });
}

/** Who is editing which trail now (`owner:id`), newest mark per member. */
export function editors(data: TeamData, now: number): Map<string, string> {
  const newest = new Map<string, { trail: string | null; stamp: Stamp }>();
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'msg' || rec.owner === undefined || rec.state.created === undefined) continue;
    if (!isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    if (f['th'] !== SYS_EDIT || typeof f['tx'] !== 'string' || f['tx'].length > 200) continue;
    if (now - rec.state.created.wall > EDIT_PRESENCE_MS) continue;
    let trail: string | null = null;
    try {
      const v = JSON.parse(f['tx']) as { t?: unknown };
      trail = typeof v.t === 'string' && v.t.length <= 120 ? v.t : null;
    } catch {
      continue;
    }
    const prev = newest.get(rec.owner);
    if (prev === undefined || compareStamp(rec.state.created, prev.stamp) > 0)
      newest.set(rec.owner, { trail, stamp: rec.state.created });
  }
  const out = new Map<string, string>();
  for (const [member, v] of newest) if (v.trail !== null) out.set(member, v.trail);
  return out;
}
