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
import type { TeamRally, TeamSos } from './field';
import { rallyEntity, sosEntity } from './alertLedger';
import { rangeAndBearing, shortAge } from './positions';
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
  /** A gather's place: its text, else its coordinates. */
  place: string;
}

export interface AlertInputs {
  soses: readonly TeamSos[];
  rally: TeamRally | null;
  me: string;
  names: ReadonlyMap<string, string>;
  /** Teammates' live positions (an SOS follows its raiser). */
  positions: readonly { id: string; lat: number; lon: number }[];
}

const coords = (lat: number, lng: number) => `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

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
      place: r.text.trim() || coords(r.lat, r.lng),
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
    const where = rb ? `${distanceText(rb.meters)} ${rb.compass}` : null;
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
  const sub = [rb ? distanceText(rb.meters) : null, `by ${first}`].filter(Boolean).join(' · ');
  return {
    title,
    sub,
    a11y: `${title}, ${sub}`,
    actions: o.isAdmin ? ['navigate', 'end'] : ['navigate'],
  };
}

/** The bands to draw: the top one and a count, or (expanded) up to three. */
export function bandStack(
  alerts: readonly ActiveAlert[],
  expanded: boolean,
): { shown: ActiveAlert[]; more: number } {
  const n = expanded ? Math.min(MAX_STACKED_BANDS, alerts.length) : Math.min(1, alerts.length);
  return { shown: alerts.slice(0, n), more: alerts.length - n };
}
