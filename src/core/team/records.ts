import type { Json } from './canonical';
import { isLive, visibleFields, type EntityState } from './crdt';
import { isMemberId, isShortId } from './ids';
import { isAdminRole, type Role } from './roles';

/**
 * Team records beyond tasks (#589, owner 2026-10-07): collaborative trails,
 * SOS, rally points and "resolved" marks on messages. Each kind's fields are
 * validated on every write, and each write is authorized by the author's role
 * at its place in the fold (`data.ts` calls {@link authorizeRecord}).
 *
 * | kind | key | who writes | who deletes |
 * |---|---|---|---|
 * | `trl` team trail | owned (creator) | creator: all; members: name/desc/color; `base` once, at creation | creator or admin |
 * | `tve` trail vertex | keyed by the TRAIL's owner (`tve:<to>:<id>`) | members, on a live `trl`; inserts capped | members (with `o` = the trail's owner) |
 * | `sos` | owned (raiser) | raiser (guests too); raiser or admin: the resolution | raiser or admin |
 * | `rly` rally point | owned (creator) | creator (members) | creator or admin |
 * | `mres` message resolved | owned by the MESSAGE's author, id = message id | its author, an admin, or someone it mentions (guests too) | — |
 *
 * Status-like fields are written whole (the "done by the wrong person" lesson):
 * `res: true` with `rby` = the author and `rat`; `res: false` with both null.
 */

export const RECORD_KINDS = ['trl', 'tve', 'sos', 'rly', 'mres'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const MAX_TRAIL_NAME = 80;
export const MAX_TRAIL_DESC = 1000;
export const MAX_TRAIL_BASE_CHARS = 20_000;
export const MAX_TRAIL_VERTICES = 2_000;
export const MAX_SOS_TEXT = 200;
export const MAX_RALLY_TEXT = 80;
export const TRAIL_META_FIELDS: readonly string[] = ['name', 'desc', 'color'];
export const RESOLUTION_FIELDS: readonly string[] = ['res', 'rby', 'rat'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown, max: number, min = 1) =>
  typeof v === 'string' && v.trim().length >= min && v.length <= max;
const lat = (v: unknown) => finite(v) && Math.abs(v) <= 90;
const lng = (v: unknown) => finite(v) && Math.abs(v) <= 180;
const has = (f: Record<string, Json>, k: string) => Object.prototype.hasOwnProperty.call(f, k);
const only = (f: Record<string, Json>, keys: readonly string[]) =>
  Object.keys(f).every((k) => keys.includes(k));

/**
 * A fractional-index key: base-36 digits, at most {@link MAX_KEY} long, never
 * ending in `0` (canonical: then two different keys always have room between
 * them, and nobody can plant an `a`/`a0` pair with nothing in between).
 */
export const MAX_KEY = 256;
export const KEY = /^[0-9a-z]{0,255}[1-9a-z]$/;
/** Trail ids carry no `_` (a vertex id is `<trail>_<suffix>`). */
export const TRAIL_ID = /^[A-Za-z0-9-]{1,40}$/;
/** Live vertices a trail may hold, and vertex records it may ever collect. */
export const MAX_LIVE_VERTICES = 2_000;
export const MAX_VERTEX_RECORDS = 4_000;

/** Encoded polyline (1e5) → `[lng, lat]` points; null for anything malformed. Total. */
export function decodeLine(src: string, maxPoints: number): [number, number][] | null {
  const out: [number, number][] = [];
  let i = 0;
  let la = 0;
  let lo = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= src.length || shift > 30) return null;
      const b = src.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < src.length) {
    const dla = next();
    const dlo = next();
    if (dla === null || dlo === null) return null;
    la += dla;
    lo += dlo;
    if (out.length >= maxPoints) return null;
    const p: [number, number] = [lo / 1e5, la / 1e5];
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return null;
    out.push(p);
  }
  return out;
}

/** `res`/`rby`/`rat` written whole, `rby` = the author. */
function validResolution(f: Record<string, Json>, author: string): boolean {
  const any = RESOLUTION_FIELDS.some((k) => has(f, k));
  if (!any) return true;
  if (!RESOLUTION_FIELDS.every((k) => has(f, k))) return false;
  if (f['res'] === true) return f['rby'] === author && time(f['rat']);
  return f['res'] === false && f['rby'] === null && f['rat'] === null;
}

export function validTrailFields(f: Record<string, Json>): boolean {
  for (const [k, v] of Object.entries(f)) {
    switch (k) {
      case 'name':
        if (!text(v, MAX_TRAIL_NAME)) return false;
        break;
      case 'desc':
        if (!text(v, MAX_TRAIL_DESC, 0)) return false;
        break;
      case 'color':
        if (typeof v !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(v)) return false;
        break;
      case 'base': {
        if (typeof v !== 'string' || v.length > MAX_TRAIL_BASE_CHARS) return false;
        const pts = decodeLine(v, MAX_TRAIL_VERTICES);
        if (pts === null || pts.length < 2) return false;
        break;
      }
      case 'so':
        if (!isMemberId(v)) return false;
        break;
      case 'si':
        if (!isShortId(v)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** A base vertex's id: `<trail>_b<index>`; an inserted vertex: `<trail>_<random>`. */
export const BASE_VERTEX = /_b(\d{1,4})$/;

/** The trail a vertex id belongs to (`<trail>_<suffix>`), or null. */
export function vertexTrail(id: string): string | null {
  const i = id.indexOf('_');
  return i > 0 && i < id.length - 1 ? id.slice(0, i) : null;
}

export function validVertexFields(id: string, f: Record<string, Json>): boolean {
  if (!isMemberId(f['to']) || typeof f['tr'] !== 'string' || !TRAIL_ID.test(f['tr'])) return false;
  if (vertexTrail(id) !== f['tr']) return false;
  const base = BASE_VERTEX.test(id);
  for (const [k, v] of Object.entries(f)) {
    if (k === 'to' || k === 'tr') continue;
    if (
      k === 'la'
        ? !lat(v)
        : k === 'lo'
          ? !lng(v)
          : k === 'k'
            ? base || typeof v !== 'string' || !KEY.test(v)
            : true
    )
      return false;
  }
  return true;
}

export function validSosFields(f: Record<string, Json>, author: string): boolean {
  if (!validResolution(f, author)) return false;
  return Object.entries(f).every(([k, v]) =>
    k === 'la'
      ? lat(v)
      : k === 'lo'
        ? lng(v)
        : k === 'tx'
          ? text(v, MAX_SOS_TEXT, 0)
          : RESOLUTION_FIELDS.includes(k),
  );
}

export function validRallyFields(f: Record<string, Json>): boolean {
  return Object.entries(f).every(([k, v]) =>
    k === 'la'
      ? lat(v)
      : k === 'lo'
        ? lng(v)
        : k === 'tx'
          ? text(v, MAX_RALLY_TEXT, 0)
          : k === 'at'
            ? v === null || time(v)
            : k === 'r'
              ? finite(v) && v >= 10 && v <= 1000
              : false,
  );
}

export function validResolutionFields(f: Record<string, Json>, author: string): boolean {
  return only(f, RESOLUTION_FIELDS) && validResolution(f, author);
}

/** What the fold needs to authorize a record write. */
export interface RecordWrite {
  kind: RecordKind;
  id: string;
  /** `o`: whose record this updates (absent: the author's own). */
  o: string | undefined;
  f: Record<string, Json>;
  author: string;
  role: Role;
}

type Lookup = (kind: string, id: string, owner?: string) => { state: EntityState } | undefined;

/**
 * Counters the fold keeps as it goes (review: no scans per write), so each
 * record write is authorized in constant time:
 * - per trail (`owner:trail`): its base length (decoded once), its vertex
 *   records, live inserted vertices and deleted base vertices;
 * - per member: their open SOS ids and the newest resolve time of theirs.
 */
export interface RecordIndex {
  baseLen: Map<string, number>;
  vtx: Map<string, { total: number; liveInserted: number; deletedBase: number }>;
  sosOpen: Map<string, Set<string>>;
  sosLastResolved: Map<string, number>;
}

export function emptyIndex(): RecordIndex {
  return { baseLen: new Map(), vtx: new Map(), sosOpen: new Map(), sosLastResolved: new Map() };
}

/** Work done by the index (decodes): the linear-time regression test counts it. */
export const indexWork = { decodes: 0 };

function vertexClass(id: string, state: EntityState | undefined) {
  if (state === undefined) return { liveInserted: 0, deletedBase: 0 };
  const alive = isLive(state);
  if (BASE_VERTEX.test(id))
    return { liveInserted: 0, deletedBase: !alive && state.deleted !== undefined ? 1 : 0 };
  return { liveInserted: alive && state.fields['k'] !== undefined ? 1 : 0, deletedBase: 0 };
}

/** Keep the index in step with one merged record (`before` = its state before the op). */
export function reindex(
  idx: RecordIndex,
  rec: { kind: string; id: string; owner?: string | undefined; state: EntityState },
  before: EntityState | undefined,
): void {
  const owner = rec.owner;
  if (owner === undefined) return;
  if (rec.kind === 'trl') {
    const key = `${owner}:${rec.id}`;
    const base = rec.state.fields['base']?.value;
    if (!idx.baseLen.has(key) && typeof base === 'string') {
      indexWork.decodes++;
      idx.baseLen.set(key, decodeLine(base, MAX_TRAIL_VERTICES)?.length ?? 0);
    }
  } else if (rec.kind === 'tve') {
    const tr = vertexTrail(rec.id);
    if (tr === null) return;
    const key = `${owner}:${tr}`;
    const c = idx.vtx.get(key) ?? { total: 0, liveInserted: 0, deletedBase: 0 };
    const a = vertexClass(rec.id, before);
    const b = vertexClass(rec.id, rec.state);
    if (before === undefined) c.total++;
    c.liveInserted += b.liveInserted - a.liveInserted;
    c.deletedBase += b.deletedBase - a.deletedBase;
    idx.vtx.set(key, c);
  } else if (rec.kind === 'sos') {
    const open = idx.sosOpen.get(owner) ?? new Set<string>();
    const alive = isLive(rec.state);
    const res = alive ? visibleFields(rec.state)['res'] === true : false;
    if (alive && !res) open.add(rec.id);
    else open.delete(rec.id);
    idx.sosOpen.set(owner, open);
    const resReg = rec.state.fields['res'];
    if (alive && res && resReg !== undefined)
      idx.sosLastResolved.set(
        owner,
        Math.max(idx.sosLastResolved.get(owner) ?? 0, resReg.stamp.wall),
      );
  }
}

/** After an SOS is resolved, its raiser waits this long before raising another. */
export const SOS_COOLDOWN_MS = 60_000;

const live = (r: { state: EntityState } | undefined): r is { state: EntityState } =>
  r !== undefined && isLive(r.state);

/**
 * The owner to key the write under, or why it is refused. `invalid`: the
 * fields are malformed. `forbidden`: well formed, but not this author's to write.
 */
export function authorizeRecord(
  w: RecordWrite,
  get: Lookup,
  idx: RecordIndex = emptyIndex(),
  wall = 0,
): { owner: string | undefined } | 'invalid' | 'forbidden' {
  const { kind, id, f, author, role } = w;
  const admin = isAdminRole(role);
  switch (kind) {
    case 'trl': {
      if (role === 'guest') return 'forbidden';
      if (!validTrailFields(f)) return 'invalid';
      const owner = w.o ?? author;
      const cur = get('trl', id, owner);
      if (owner !== author) {
        // Members edit the meta of an existing trail; never its base.
        if (!live(cur) || !only(f, TRAIL_META_FIELDS)) return 'forbidden';
        return { owner };
      }
      if (cur === undefined) {
        // A new trail: its base line and a name, and an id with no `_`.
        if (!TRAIL_ID.test(id) || !has(f, 'base') || !has(f, 'name')) return 'invalid';
      } else if (has(f, 'base') && cur.state.fields['base'] !== undefined) {
        return 'forbidden'; // the base is written once
      }
      return { owner };
    }
    case 'tve': {
      if (role === 'guest') return 'forbidden';
      if (!validVertexFields(id, f)) return 'invalid';
      const to = f['to'] as string;
      if (w.o !== undefined && w.o !== to) return 'invalid';
      const trail = get('trl', f['tr'] as string, to);
      if (!live(trail)) return 'forbidden';
      // A new inserted vertex: within the trail's caps.
      if (!BASE_VERTEX.test(id) && get('tve', id, to) === undefined) {
        const key = `${to}:${f['tr'] as string}`;
        const c = idx.vtx.get(key) ?? { total: 0, liveInserted: 0, deletedBase: 0 };
        if (c.total >= MAX_VERTEX_RECORDS) return 'forbidden';
        const live = (idx.baseLen.get(key) ?? 0) + c.liveInserted - c.deletedBase;
        if (live >= MAX_LIVE_VERTICES) return 'forbidden';
      }
      return { owner: to };
    }
    case 'sos': {
      if (!validSosFields(f, author)) return 'invalid';
      const owner = w.o ?? author;
      if (owner !== author) {
        // An admin resolves someone else's live SOS; nothing else.
        if (!admin || !live(get('sos', id, owner)) || !only(f, RESOLUTION_FIELDS))
          return 'forbidden';
        return { owner };
      }
      const prev = get('sos', id, owner);
      if (prev !== undefined && live(prev) && visibleFields(prev.state)['res'] === true) {
        // A resolved SOS opens again only with the whole trio (res: false…).
        if ((has(f, 'la') || has(f, 'lo') || has(f, 'tx')) && f['res'] !== false) return 'invalid';
      }
      if (prev === undefined) {
        if (!has(f, 'la') || !has(f, 'lo')) return 'invalid';
        // Spam guard: one open SOS per member, and a cooldown after a resolve.
        if ((idx.sosOpen.get(owner)?.size ?? 0) > 0) return 'forbidden';
        const last = idx.sosLastResolved.get(owner);
        if (last !== undefined && wall - last < SOS_COOLDOWN_MS) return 'forbidden';
      }
      return { owner };
    }
    case 'rly': {
      if (role === 'guest') return 'forbidden';
      if (w.o !== undefined || !validRallyFields(f)) return 'invalid';
      if (get('rly', id, author) === undefined && (!has(f, 'la') || !has(f, 'lo')))
        return 'invalid';
      return { owner: author };
    }
    case 'mres': {
      if (!validResolutionFields(f, author)) return 'invalid';
      const owner = w.o ?? author;
      const msg = get('msg', id, owner);
      if (!live(msg)) return 'forbidden';
      if (owner !== author && !admin) {
        const mn = visibleFields(msg.state)['mn'];
        if (!Array.isArray(mn) || !mn.includes(author)) return 'forbidden';
      }
      return { owner };
    }
  }
}

// ── Fractional keys (inserted trail vertices) ────────────────────────────────

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** The base key of base vertex `i`: "h" + four base-36 digits + "i" (canonical, sorts by index). */
export function baseKey(i: number): string {
  return `h${i.toString(36).padStart(4, '0')}i`;
}

/**
 * A canonical key strictly between `a` and `b` (null = open end), or null when
 * there is none within {@link MAX_KEY} characters or the inputs are not two
 * canonical keys in order. Never out of order (property-tested).
 */
export function keyBetween(a: string | null, b: string | null): string | null {
  if (a !== null && !KEY.test(a)) return null;
  if (b !== null && !KEY.test(b)) return null;
  if (a !== null && b !== null && a >= b) return null;
  const lo = a ?? '';
  let out = '';
  for (let i = 0; i < MAX_KEY; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    let db: number;
    if (b === null) db = 36;
    else if (i < b.length) db = DIGITS.indexOf(b[i]!);
    else return null; // cannot happen for canonical a < b
    if (db < da) return null;
    if (db - da > 1) {
      const key = out + DIGITS[Math.floor((da + db) / 2)]!;
      return key.length <= MAX_KEY ? key : null;
    }
    out += DIGITS[da]!;
    if (db - da === 1) {
      // Keep a's digit here, then anything above the rest of a.
      const rest = keyAbove(lo.slice(i + 1), MAX_KEY - out.length);
      return rest === null ? null : out + rest;
    }
  }
  return null;
}

/** The shortest canonical suffix above `rest` (an open upper end), within `room` chars. */
function keyAbove(rest: string, room: number): string | null {
  let out = '';
  for (let i = 0; i < room; i++) {
    const d = i < rest.length ? DIGITS.indexOf(rest[i]!) : 0;
    if (36 - d > 1) return out + DIGITS[Math.floor((d + 36) / 2)]!;
    out += DIGITS[d]!;
  }
  return null;
}

// ── Reading: a trail's vertices ──────────────────────────────────────────────

export interface TrailVertex {
  /** `<trail>_b<i>` or `<trail>_<random>`. */
  id: string;
  key: string;
  lng: number;
  lat: number;
  inserted: boolean;
}

/** The live vertex list of trail `tr` (owner `to`): base points, moved, deleted, inserted. */
export function trailVertices(
  base: readonly (readonly [number, number])[],
  tr: string,
  to: string,
  edits: Iterable<{ id: string; state: EntityState }>,
): TrailVertex[] {
  const byId = new Map<string, { id: string; state: EntityState }>();
  for (const e of edits) byId.set(e.id, e);
  const out: TrailVertex[] = [];
  base.forEach((p, i) => {
    const id = `${tr}_b${i}`;
    const e = byId.get(id);
    if (e && e.state.deleted !== undefined && !isLive(e.state)) return; // deleted
    const vis = e && isLive(e.state) ? visibleFields(e.state) : {};
    // An edit naming another trail is ignored (the base point stands).
    const f = vis['to'] === to && vis['tr'] === tr ? vis : {};
    out.push({
      id,
      key: baseKey(i),
      lng: finite(f['lo']) ? f['lo'] : p[0],
      lat: finite(f['la']) ? f['la'] : p[1],
      inserted: false,
    });
  });
  for (const e of byId.values()) {
    if (BASE_VERTEX.test(e.id) || !isLive(e.state)) continue;
    const f = visibleFields(e.state);
    if (f['to'] !== to || f['tr'] !== tr) continue;
    if (typeof f['k'] !== 'string' || !finite(f['la']) || !finite(f['lo'])) continue;
    out.push({ id: e.id, key: f['k'], lng: f['lo'], lat: f['la'], inserted: true });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
}
