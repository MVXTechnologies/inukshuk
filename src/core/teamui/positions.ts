/**
 * Teammates on the map (#589 UI): each member's last shared position as a
 * GeoJSON point for the native MapLibre layers, plus the card's distance,
 * bearing and age. Pure.
 *
 * Age is BANDED (fresh / recent / stale), never continuous: the layers style
 * by band, and nothing keys a symbol sort on a continuous value (one draw per
 * distinct key per frame — the Alps-lag lesson, maplibre-symbol-sort-key-cost).
 */
import type { FeatureCollection } from 'geojson';

import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import type { PosBody } from '@core/team/data';
import type { Register } from '@core/team/crdt';
import type { Json } from '@core/team/canonical';
import type { Role } from '@core/team/roles';

import type { MemberRow } from './view';

/** ≤ 2 min: live. */
export const FRESH_MS = 2 * 60_000;
/** ≤ 15 min: recent. Older: stale (drawn faded, labelled with its age). */
export const RECENT_MS = 15 * 60_000;

export type AgeBand = 'fresh' | 'recent' | 'stale';

export function ageBand(ageMs: number): AgeBand {
  if (ageMs <= FRESH_MS) return 'fresh';
  if (ageMs <= RECENT_MS) return 'recent';
  return 'stale';
}

/** "now", "4 min", "2 h", "3 d" — compact, for map labels and rows. */
export function shortAge(ageMs: number): string {
  const s = Math.max(0, ageMs) / 1000;
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export interface TeammatePosition {
  id: string;
  name: string;
  initials: string;
  color: string;
  role: Role;
  lat: number;
  lon: number;
  /** Horizontal accuracy, m. */
  accuracy: number | null;
  elevation: number | null;
  /** When the fix was taken (the sender's clock). */
  at: number;
  ageMs: number;
  band: AgeBand;
}

/** Positions of the OTHER active members, newest fix each. */
export function teammatePositions(
  positions: ReadonlyMap<string, Register<PosBody & Record<string, Json>>>,
  members: readonly MemberRow[],
  now: number,
): TeammatePosition[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const out: TeammatePosition[] = [];
  for (const [id, reg] of positions) {
    const m = byId.get(id);
    if (m === undefined || m.isMe || !m.active) continue;
    const p = reg.value;
    // A fix "from the future" (the sender's clock runs fast) reads as now.
    const at = Math.min(p.at, now);
    const ageMs = now - at;
    out.push({
      id,
      name: m.name,
      initials: m.initials,
      color: m.color,
      role: m.role,
      lat: p.la,
      lon: p.lo,
      accuracy: typeof p.ac === 'number' ? p.ac : null,
      elevation: typeof p.el === 'number' ? p.el : null,
      at,
      ageMs,
      band: ageBand(ageMs),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Role ring: admins and the owner get the gold ring, everyone else the paper one. */
export function roleRing(role: Role): 'lead' | 'member' | 'guest' {
  return role === 'owner' || role === 'admin' ? 'lead' : role === 'guest' ? 'guest' : 'member';
}

/** The FeatureCollection the team layers draw (`TeamMapLayers`). */
export function teammatesGeoJson(list: readonly TeammatePosition[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: list.map((p) => ({
      type: 'Feature',
      id: p.id,
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        member: p.id,
        initials: p.initials,
        color: p.color,
        ring: roleRing(p.role),
        band: p.band,
        label: p.band === 'fresh' ? p.name : `${p.name} · ${shortAge(p.ageMs)}`,
      },
    })),
  };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function compassPoint(bearingDeg: number): string {
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return COMPASS[i] ?? 'N';
}

export interface RangeAndBearing {
  meters: number;
  bearingDeg: number;
  compass: string;
}

export function rangeAndBearing(
  from: { latitude: number; longitude: number },
  to: { lat: number; lon: number },
): RangeAndBearing {
  const target = { latitude: to.lat, longitude: to.lon };
  const bearingDeg = initialBearingDeg(from, target);
  return {
    meters: haversineMeters(from, target),
    bearingDeg,
    compass: compassPoint(bearingDeg),
  };
}
