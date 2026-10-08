/**
 * Field coordination readers (#589, owner 2026-10-07): SOS and rally points
 * from the data view, rally arrivals and ETAs from positions. Pure.
 */
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';

export interface TeamSos {
  id: string;
  owner: string;
  lng: number;
  lat: number;
  text: string;
  at: number;
  resolved: boolean;
  resolvedBy: string | null;
}

export interface TeamRally {
  id: string;
  owner: string;
  lng: number;
  lat: number;
  text: string;
  /** Meeting time, or null. */
  when: number | null;
  radius: number;
  at: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every live SOS, open ones first, newest first. */
export function teamSos(data: TeamData): TeamSos[] {
  const out: TeamSos[] = [];
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'sos' || rec.owner === undefined || !isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    if (!finite(f['la']) || !finite(f['lo'])) continue;
    out.push({
      id: rec.id,
      owner: rec.owner,
      lng: f['lo'],
      lat: f['la'],
      text: typeof f['tx'] === 'string' ? f['tx'] : '',
      at: rec.state.created?.wall ?? 0,
      resolved: f['res'] === true,
      resolvedBy: f['res'] === true && typeof f['rby'] === 'string' ? f['rby'] : null,
    });
  }
  return out.sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.at - a.at);
}

/** The team's rally point: the newest live one, or null. */
export function teamRally(data: TeamData): TeamRally | null {
  let best: TeamRally | null = null;
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'rly' || rec.owner === undefined || !isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    if (!finite(f['la']) || !finite(f['lo'])) continue;
    const r: TeamRally = {
      id: rec.id,
      owner: rec.owner,
      lng: f['lo'],
      lat: f['la'],
      text: typeof f['tx'] === 'string' ? f['tx'] : '',
      when: finite(f['at']) ? f['at'] : null,
      radius: finite(f['r']) ? f['r'] : 60,
      at: rec.state.created?.wall ?? 0,
    };
    if (best === null || r.at > best.at || (r.at === best.at && r.id > best.id)) best = r;
  }
  return best;
}

export function metres(a: readonly [number, number], b: readonly [number, number]): number {
  const r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r;
  const dLng = (b[0] - a[0]) * r;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A walking pace for ETAs when a member's own speed is unknown (m/s). */
export const WALK_MPS = 1.2;

export interface RallyArrival {
  id: string;
  distanceM: number | null;
  arrived: boolean;
  /** Minutes at their pace (or walking pace), null when their position is unknown. */
  etaMin: number | null;
}

/** Who has arrived (inside the circle) and everyone else's distance and ETA. */
export function rallyArrivals(
  rally: TeamRally,
  people: readonly { id: string; at: readonly [number, number] | null; speedMps?: number | null }[],
): RallyArrival[] {
  return people.map((p) => {
    if (p.at === null) return { id: p.id, distanceM: null, arrived: false, etaMin: null };
    const d = metres(p.at, [rally.lng, rally.lat]);
    const arrived = d <= rally.radius;
    const pace = p.speedMps && p.speedMps > 0.3 ? p.speedMps : WALK_MPS;
    return {
      id: p.id,
      distanceM: d,
      arrived,
      etaMin: arrived ? 0 : Math.max(1, Math.round(d / pace / 60)),
    };
  });
}
