/**
 * The active SOS / gather band (#708): what is active, in what order, and
 * what each band says and offers. Pure.
 *
 * - An active SOS or gather is a STATE: its band stays until it is resolved
 *   or ended, for everyone, the raiser included.
 * - **Ranking:** every SOS outranks every gather. Among SOS, a teammate's
 *   comes before mine (it needs me), newest first. One gather at most (the
 *   team's rally point).
 * - **Collapsed:** the top band and "+N"; expanded, up to
 *   {@link MAX_STACKED_BANDS} bands stacked, the rest left to the panel.
 * - **Texts:** others' SOS "SOS · Julie Tremblay" / "640 m NE · 2 min"; my
 *   own "Your SOS is active" / "3 of 5 received · 1 min"; a gather
 *   "Gather · Lac-Delage" / "1.2 km · by Noé", its creator's
 *   "You called it · 4 of 5 received".
 */
import type { Units } from '@core/format';
import { formatCoordinate, type CoordinateFormat } from '@core/convert/coordinateDisplay';

import { rallyArrivals, type TeamRally, type TeamSos } from './field';
import { rallyEntity, sosEntity } from './alertLedger';
import { rangeAndBearing, shortAge, STALE_MS } from './positions';
import type { AlertRef } from './receipts';
import { distanceText } from './teamBar';

export const MAX_STACKED_BANDS = 3;

export interface ActiveAlert {
  kind: 'sos' | 'gather';
  /** `sos:<owner>:<id>` or `rly:<owner>:<id>`. */
  entity: string;
  ref: AlertRef;
  owner: string;
  ownerName: string;
  mine: boolean;
  /** Where to go: an SOS follows its raiser's live position. */
  lat: number;
  lng: number;
  /** When it was raised or called (wall ms). */
  since: number;
  /** A gather's place: its text, else its coordinates in the user's format. */
  place: string;
}

export interface AlertInputs {
  soses: readonly TeamSos[];
  rally: TeamRally | null;
  me: string;
  names: ReadonlyMap<string, string>;
  /** Teammates' live positions (an SOS follows its raiser). */
  positions: readonly { id: string; lat: number; lon: number }[];
  /**
   * The user's coordinate format (Settings), for an unnamed gather's place:
   * the same `formatCoordinate` the coordinates readout uses, so a rally
   * point reads "46°48'44.44\"N, …" or "19T 345678.9 …" when that is the
   * user's choice, not always decimal degrees.
   */
  coordinateFormat: CoordinateFormat;
}

/** Every active SOS and gather, ranked (see the module doc). */
export function activeAlerts(i: AlertInputs): ActiveAlert[] {
  const name = (id: string) => (id === i.me ? 'You' : (i.names.get(id) ?? 'A teammate'));
  const sos: ActiveAlert[] = i.soses
    .filter((s) => !s.resolved)
    .map((s) => {
      const live = i.positions.find((p) => p.id === s.owner);
      return {
        kind: 'sos',
        entity: sosEntity(s),
        ref: { kind: 'sos', owner: s.owner, id: s.id },
        owner: s.owner,
        ownerName: name(s.owner),
        mine: s.owner === i.me,
        lat: live ? live.lat : s.lat,
        lng: live ? live.lon : s.lng,
        since: s.at,
        place: s.text,
      };
    });
  sos.sort((a, b) => Number(a.mine) - Number(b.mine) || b.since - a.since);
  const out = [...sos];
  const r = i.rally;
  if (r !== null) {
    out.push({
      kind: 'gather',
      entity: rallyEntity(r),
      ref: { kind: 'rly', owner: r.owner, id: r.id },
      owner: r.owner,
      ownerName: name(r.owner),
      mine: r.owner === i.me,
      lat: r.lat,
      lng: r.lng,
      since: r.at,
      place: r.text.trim() || formatCoordinate(r.lat, r.lng, i.coordinateFormat),
    });
  }
  return out;
}

export type BandAction = 'navigate' | 'centre' | 'resolve' | 'end';

export interface BandModel {
  title: string;
  sub: string;
  a11y: string;
  /** Buttons, left to right; a tap on the text centres the map. */
  actions: BandAction[];
}

const ageText = (ms: number) => {
  const a = shortAge(ms);
  return a === 'now' ? 'just now' : a;
};

/** What a band says and offers to this phone. */
export function bandModel(
  a: ActiveAlert,
  o: {
    here: { latitude: number; longitude: number } | null;
    now: number;
    /** "3 of 5 received" / "Sent" (for my own alerts). */
    receipts: string;
    isAdmin: boolean;
    /** The user's display units (#702). */
    units: Units;
  },
): BandModel {
  const rb = o.here ? rangeAndBearing(o.here, { lat: a.lat, lon: a.lng }) : null;
  const age = ageText(o.now - a.since);
  const first = a.ownerName.split(' ')[0] ?? a.ownerName;
  if (a.kind === 'sos') {
    if (a.mine) {
      const sub = `${o.receipts} · ${age}`;
      return {
        title: 'Your SOS is active',
        sub,
        a11y: `Your SOS is active, ${sub}`,
        actions: ['resolve'],
      };
    }
    const where = rb ? `${distanceText(rb.meters, o.units)} ${rb.compass}` : null;
    const sub = [where, age].filter(Boolean).join(' · ');
    return {
      title: `SOS · ${a.ownerName}`,
      sub,
      a11y: `SOS from ${a.ownerName}, ${sub}`,
      actions: o.isAdmin ? ['navigate', 'resolve'] : ['navigate', 'centre'],
    };
  }
  const title = `Gather · ${a.place}`;
  if (a.mine) {
    const sub = `You called it · ${o.receipts}`;
    return { title, sub, a11y: `${title}, ${sub}`, actions: ['end'] };
  }
  const sub = [rb ? distanceText(rb.meters, o.units) : null, `by ${first}`]
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    sub,
    a11y: `${title}, ${sub}`,
    actions: o.isAdmin ? ['navigate', 'end'] : ['navigate'],
  };
}

/** One member's way to the gather (#708; the old rally pill's ETA list). */
export interface GatherEta {
  id: string;
  name: string;
  isMe: boolean;
  /** Metres to the rally point, null without a recent position. */
  distanceM: number | null;
  /** Minutes at walking pace (`rallyArrivals`), null without a recent position. */
  etaMin: number | null;
  arrived: boolean;
  /** "there", "~12 min" or "—". */
  eta: string;
  /** "640 m" (in the user's units) or "—". */
  distance: string;
}

/**
 * Every active member's distance and ETA to the rally point, nearest to
 * arrive first: those already inside its circle, then by ETA (then
 * distance), then members without a recent position (none, or older than
 * {@link STALE_MS}), shown "—". My own row uses my live fix.
 */
export function gatherEtas(
  rally: TeamRally,
  members: readonly { id: string; name: string; isMe: boolean; active: boolean }[],
  positions: readonly { id: string; lat: number; lon: number; ageMs: number }[],
  here: { latitude: number; longitude: number } | null,
  units: Units,
): GatherEta[] {
  const active = members.filter((m) => m.active);
  const people = active.map((m) => {
    if (m.isMe) return { id: m.id, at: here ? ([here.longitude, here.latitude] as const) : null };
    const p = positions.find((x) => x.id === m.id);
    return { id: m.id, at: p && p.ageMs <= STALE_MS ? ([p.lon, p.lat] as const) : null };
  });
  const arrivals = new Map(rallyArrivals(rally, people).map((a) => [a.id, a]));
  const rows = active.map((m): GatherEta => {
    const a = arrivals.get(m.id) ?? { distanceM: null, etaMin: null, arrived: false };
    return {
      id: m.id,
      name: m.isMe ? 'You' : m.name,
      isMe: m.isMe,
      distanceM: a.distanceM,
      etaMin: a.etaMin,
      arrived: a.arrived,
      eta: a.arrived ? 'there' : a.etaMin === null ? '—' : `~${a.etaMin} min`,
      distance: a.distanceM === null ? '—' : distanceText(a.distanceM, units),
    };
  });
  const FAR = Number.MAX_SAFE_INTEGER;
  return rows.sort(
    (a, b) =>
      Number(b.arrived) - Number(a.arrived) ||
      (a.etaMin ?? FAR) - (b.etaMin ?? FAR) ||
      (a.distanceM ?? FAR) - (b.distanceM ?? FAR) ||
      (a.name < b.name ? -1 : 1),
  );
}

/** The bands to draw: the top one and a count, or (expanded) up to three. */
export function bandStack(
  alerts: readonly ActiveAlert[],
  expanded: boolean,
): { shown: ActiveAlert[]; more: number } {
  const n = expanded ? Math.min(MAX_STACKED_BANDS, alerts.length) : Math.min(1, alerts.length);
  return { shown: alerts.slice(0, n), more: alerts.length - n };
}
