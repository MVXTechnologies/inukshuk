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
 * - **Texts:** others' SOS "Julie Tremblay" (under an "SOS" badge, #756) / "640 m NE · 2 min"; my
 *   own "Your SOS is active" / "3 of 5 received · 1 min"; a gather
 *   "Gather · Lac-Delage" / "1.2 km · by Noé", its creator's
 *   "By you · 4 of 5 received". An unnamed gather is "Gather point": its
 *   coordinates (a long string in any format) go in the expanded list and
 *   the screen-reader label, never in the band's one-line title, which they
 *   overflowed on a phone (QA 2.6.1).
 */
import { MAP_EDGE_INSET, MAP_LANE_INSET } from '@core/map/mapChrome';
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
  /** Whether the place is a name (its text), not coordinates. */
  named: boolean;
  /** Its coordinates in the user's format (the expanded list shows them). */
  coords: string;
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
        named: s.text.trim() !== '',
        coords: formatCoordinate(s.lat, s.lng, i.coordinateFormat),
      };
    });
  sos.sort((a, b) => Number(a.mine) - Number(b.mine) || b.since - a.since);
  const out = [...sos];
  const r = i.rally;
  if (r !== null) {
    const coords = formatCoordinate(r.lat, r.lng, i.coordinateFormat);
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
      place: r.text.trim() || coords,
      named: r.text.trim() !== '',
      coords,
    });
  }
  return out;
}

export type BandAction = 'navigate' | 'centre' | 'resolve' | 'end';

export interface BandModel {
  title: string;
  /**
   * Others' SOS: "SOS" rides the band's badge (#756), so the title is the
   * name alone and is never cut to "SOS · Julie Trem…" at 360 dp.
   */
  tag: 'SOS' | null;
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
        tag: null,
        sub,
        a11y: `Your SOS is active, ${sub}`,
        actions: ['resolve'],
      };
    }
    const where = rb ? `${distanceText(rb.meters, o.units)} ${rb.compass}` : null;
    const sub = [where, age].filter(Boolean).join(' · ');
    return {
      title: a.ownerName,
      tag: 'SOS',
      sub,
      a11y: `SOS from ${a.ownerName}, ${sub}`,
      actions: o.isAdmin ? ['navigate', 'resolve'] : ['navigate', 'centre'],
    };
  }
  const title = a.named ? `Gather · ${a.place}` : 'Gather point';
  const said = `Gather at ${a.place}`;
  if (a.mine) {
    const sub = `By you · ${o.receipts}`;
    return { title, tag: null, sub, a11y: `${said}, ${sub}`, actions: ['end'] };
  }
  const sub = [rb ? distanceText(rb.meters, o.units) : null, `by ${first}`]
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    tag: null,
    sub,
    a11y: `${said}, ${sub}`,
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

/**
 * Where the active SOS / gather band shows on the map (#708, owner's rule):
 * in the team bar's column while the bar is on screen, else in the strip
 * area. Never nowhere while team mode is on: a card, a sheet, Draw mode or
 * an area being drawn hides the bar or the SOS button, never the band
 * (QA 2.6.1: an active SOS vanished in Draw mode).
 */
export type AlertBandPlace = 'bar' | 'strip' | 'none';

export function alertBandPlace(i: {
  /** The map's top slot is the team's (team mode, I am an active member). */
  teamMode: boolean;
  /** The team status bar is drawn in that slot right now. */
  barShown: boolean;
}): AlertBandPlace {
  if (!i.teamMode) return 'none';
  return i.barShown ? 'bar' : 'strip';
}

/** Gap above the strip-area anchor, dp. */
export const STRIP_BAND_GAP = 8;
/**
 * The strip band's right edge clears the SOS button, which is a button of the
 * rail's column (#756): the top-centre lane's inset, 8 dp past its ring.
 */
export const STRIP_BAND_RIGHT_BESIDE_SOS = MAP_LANE_INSET;
export const STRIP_BAND_RIGHT = MAP_EDGE_INSET;

/**
 * The strip-area band's place: above the bottom chrome (the SOS button's
 * baseline), or, in team Draw mode, above the drawing tool bar and its ⓘ —
 * and then over the drawing canvas, so its buttons still answer a tap. It
 * leaves room for the SOS button only while that button is shown.
 */
export function stripBandLayout(i: {
  /** Team drawing mode owns the screen. */
  drawMode: boolean;
  /** Where the SOS button sits (above the bottom column). */
  fabBottom: number;
  /** In Draw mode: the top of the tool bar's ⓘ (`drawCreditsSheetBottom`). */
  drawChromeTop: number;
  sosButtonShown: boolean;
}): { bottom: number; right: number; overDraw: boolean } {
  return {
    bottom: (i.drawMode ? i.drawChromeTop : i.fabBottom) + STRIP_BAND_GAP,
    right: i.sosButtonShown ? STRIP_BAND_RIGHT_BESIDE_SOS : STRIP_BAND_RIGHT,
    overDraw: i.drawMode,
  };
}

/**
 * Which alerts get a band ON THE MAP (#743, owner's pick "pill only"): an SOS
 * keeps its full red band; a gather has none there. The team pill carries an
 * amber "!" for it instead ({@link gatherBadge}), and its details live in the
 * team panel ({@link gatherPanelModel}). The Team hub still shows every band.
 */
export function mapBandAlerts(alerts: readonly ActiveAlert[]): ActiveAlert[] {
  return alerts.filter((a) => a.kind === 'sos');
}

/** Whether the team pill shows the amber "!": a gather is active. */
export function gatherBadge(alerts: readonly ActiveAlert[]): boolean {
  return alerts.some((a) => a.kind === 'gather');
}

export interface GatherPanelModel {
  title: string;
  /** "1.2 km NE · by Noé"; its creator: "By you · 3 of 5 received". */
  sub: string;
  a11y: string;
  /** End (confirmed inline): its creator or an admin. */
  canEnd: boolean;
}

/**
 * The gather sub-panel's head (#743, mockup 5): who called it, the distance
 * and the direction from me (the panel has the room the band lacked), and
 * End for its creator or an admin.
 */
export function gatherPanelModel(
  a: ActiveAlert,
  o: {
    here: { latitude: number; longitude: number } | null;
    /** "3 of 5 received" / "Sent" (for my own gather). */
    receipts: string;
    isAdmin: boolean;
    units: Units;
  },
): GatherPanelModel {
  const title = a.named ? `Gather · ${a.place}` : 'Gather point';
  const said = `Gather at ${a.place}`;
  if (a.mine) {
    const sub = `By you · ${o.receipts}`;
    return { title, sub, a11y: `${said}, ${sub}`, canEnd: true };
  }
  const rb = o.here ? rangeAndBearing(o.here, { lat: a.lat, lon: a.lng }) : null;
  const first = a.ownerName.split(' ')[0] ?? a.ownerName;
  const sub = [rb ? `${distanceText(rb.meters, o.units)} ${rb.compass}` : null, `by ${first}`]
    .filter(Boolean)
    .join(' · ');
  return { title, sub, a11y: `${said}, ${sub}`, canEnd: o.isAdmin };
}
