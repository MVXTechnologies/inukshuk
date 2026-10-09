/**
 * What a member shares with the team (#589 UI) as CRDT entities:
 *
 * - a waypoint → a shared `wpt` entity (any member may edit or delete it);
 * - a recorded trail → an owned `track` entity (only its owner writes it; the
 *   owner or an admin deletes it), its geometry simplified and
 *   polyline-encoded to fit one `e.set` op (32 KiB, encrypted and base64'd).
 *
 * Photos are out of v1's UI: the core maps them (`@core/team/photos`) but the
 * blob transfer (thumbnails, full size on Wi-Fi) is stage 3.
 *
 * Field names are short and fixed (`[a-zA-Z][a-zA-Z0-9_]{0,31}`); unknown
 * fields from a later version are ignored on read. Every parser is total.
 */
import { simplifyTrack, type TrackGeometry } from '@core/geo/track/simplify';
import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import type { WaypointIcon } from '@core/models/waypoint';

const WAYPOINT_ICONS: readonly WaypointIcon[] = [
  'camp',
  'shelter',
  'water',
  'food',
  'trailhead',
  'parking',
  'summit',
  'viewpoint',
  'ford',
  'gate',
  'cache',
  'hazard',
];

export const MAX_SHARED_NAME = 80;
export const MAX_SHARED_NOTE = 1000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

// ── Waypoints ───────────────────────────────────────────────────────────────

export interface ShareableWaypoint {
  latitude: number;
  longitude: number;
  label: string;
  note?: string;
  icon?: WaypointIcon;
}

export interface TeamWaypoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  note: string | null;
  icon: WaypointIcon | null;
  /** Who shared it first (informational: a shared record has no owner). */
  by: string | null;
  at: number;
}

export function waypointFields(
  w: ShareableWaypoint,
  by: string,
  now: number,
): Record<string, Json> {
  const f: Record<string, Json> = {
    n: w.label.slice(0, MAX_SHARED_NAME),
    la: round6(w.latitude),
    lo: round6(w.longitude),
    by,
    at: Math.floor(now),
  };
  if (w.note) f['no'] = w.note.slice(0, MAX_SHARED_NOTE);
  if (w.icon) f['ic'] = w.icon;
  return f;
}

export function parseWaypoint(id: string, f: Record<string, Json>): TeamWaypoint | null {
  const la = f['la'];
  const lo = f['lo'];
  if (!finite(la) || !finite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  const icon = f['ic'];
  return {
    id,
    name: str(f['n'], MAX_SHARED_NAME) || 'Waypoint',
    lat: la,
    lon: lo,
    note: str(f['no'], MAX_SHARED_NOTE) ?? null,
    icon:
      typeof icon === 'string' && (WAYPOINT_ICONS as readonly string[]).includes(icon)
        ? (icon as WaypointIcon)
        : null,
    by: typeof f['by'] === 'string' ? f['by'] : null,
    at: finite(f['at']) ? f['at'] : 0,
  };
}

// ── Polyline (Google's encoding, 1e-5°, ~1 m) ──────────────────────────────

function encodeValue(v: number): string {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (n >= 0x20) {
    out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>>= 5;
  }
  return out + String.fromCharCode(n + 63);
}

/** `[lng, lat]` points → polyline text. */
export function encodePolyline(points: readonly [number, number][]): string {
  let lat = 0;
  let lng = 0;
  let out = '';
  for (const [x, y] of points) {
    const ly = Math.round(y * 1e5);
    const lx = Math.round(x * 1e5);
    out += encodeValue(ly - lat) + encodeValue(lx - lng);
    lat = ly;
    lng = lx;
  }
  return out;
}

/** Polyline text → `[lng, lat]` points; null for anything malformed. Total. */
export function decodePolyline(text: string, maxPoints = 20_000): [number, number][] | null {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= text.length || shift > 30) return null;
      const b = text.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    const dy = next();
    const dx = next();
    if (dy === null || dx === null) return null;
    lat += dy;
    lng += dx;
    const y = lat / 1e5;
    const x = lng / 1e5;
    if (Math.abs(y) > 90 || Math.abs(x) > 180) return null;
    out.push([x, y]);
    if (out.length > maxPoints) return null;
  }
  return out;
}

// ── Tracks ──────────────────────────────────────────────────────────────────

/**
 * Characters of polyline one track op may carry. An `e.set` op is capped at
 * 32 KiB of canonical envelope; the body is encrypted and base64url'd (×4/3)
 * and the envelope adds ~600 B, so ~23 KiB of body; 20 000 leaves room for
 * the name and stats.
 */
export const TRACK_POLYLINE_BUDGET = 20_000;
const TOLERANCES_M = [3, 6, 12, 25, 50, 100, 200, 400];

export interface ShareableTrack {
  name: string;
  points: readonly { latitude: number; longitude: number }[];
  segmentStarts?: readonly number[];
  distanceM: number;
  ascentM: number;
  startedAt: number;
  endedAt?: number;
  category?: string;
}

export interface TeamTrack {
  id: string;
  owner: string;
  name: string;
  parts: [number, number][][];
  distanceM: number;
  ascentM: number;
  startedAt: number;
  endedAt: number | null;
  category: string | null;
}

function encodeParts(geom: TrackGeometry): string {
  return geom.parts
    .filter((p) => p.length > 0)
    .map(encodePolyline)
    .join(' ');
}

/** The entity fields for a track, simplified until its geometry fits; null when empty. */
export function trackFields(t: ShareableTrack): Record<string, Json> | null {
  let encoded: string | null = null;
  for (const tol of TOLERANCES_M) {
    const text = encodeParts(simplifyTrack(t.points, t.segmentStarts ?? [], tol));
    if (text.length === 0) return null;
    if (text.length <= TRACK_POLYLINE_BUDGET) {
      encoded = text;
      break;
    }
  }
  if (encoded === null) return null; // a continent-crossing trail: refuse rather than mangle
  const f: Record<string, Json> = {
    n: t.name.slice(0, MAX_SHARED_NAME),
    p: encoded,
    d: Math.round(t.distanceM),
    a: Math.round(t.ascentM),
    t0: Math.floor(t.startedAt),
  };
  if (t.endedAt !== undefined) f['t1'] = Math.floor(t.endedAt);
  if (t.category) f['c'] = t.category.slice(0, 40);
  return f;
}

export function parseTrack(id: string, owner: string, f: Record<string, Json>): TeamTrack | null {
  const p = f['p'];
  if (typeof p !== 'string' || p.length > TRACK_POLYLINE_BUDGET * 2) return null;
  const parts: [number, number][][] = [];
  for (const chunk of p.split(' ')) {
    if (chunk.length === 0) continue;
    const pts = decodePolyline(chunk);
    if (pts === null) return null;
    parts.push(pts);
  }
  if (parts.length === 0) return null;
  return {
    id,
    owner,
    name: str(f['n'], MAX_SHARED_NAME) || 'Trail',
    parts,
    distanceM: finite(f['d']) ? f['d'] : 0,
    ascentM: finite(f['a']) ? f['a'] : 0,
    startedAt: finite(f['t0']) ? f['t0'] : 0,
    endedAt: finite(f['t1']) ? f['t1'] : null,
    category: typeof f['c'] === 'string' ? f['c'] : null,
  };
}

// ── The data view's shares ─────────────────────────────────────────────────

export interface TeamShares {
  waypoints: TeamWaypoint[];
  tracks: TeamTrack[];
}

export function teamShares(data: TeamData): TeamShares {
  const waypoints: TeamWaypoint[] = [];
  const tracks: TeamTrack[] = [];
  for (const rec of data.entities.values()) {
    if (!isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    if (rec.kind === 'wpt') {
      const w = parseWaypoint(rec.id, f);
      if (w) waypoints.push(w);
    } else if (rec.kind === 'track' && rec.owner !== undefined) {
      const t = parseTrack(rec.id, rec.owner, f);
      if (t) tracks.push(t);
    }
  }
  waypoints.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  tracks.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
  return { waypoints, tracks };
}
