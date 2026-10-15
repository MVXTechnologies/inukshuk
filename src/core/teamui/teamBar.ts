/**
 * The team status bar in the map's search slot (#707, design C) and its
 * panel's member list. Pure: the caller hands in the team snapshot.
 *
 * - **Faces:** the three freshest teammates (newest position or contact first).
 * - **Online:** me, plus every teammate seen within {@link FRESH_MS} (a fresh
 *   position, or an open sync session right now). "4/6 online".
 * - **Sync glyph:** `lan` while syncing with at least one phone, `look` while
 *   the mesh runs with nobody in reach, `off` when it does not run; then the
 *   bar reads "Offline · 12 min" (since the last word from anyone).
 *   `pending` while the mesh is wanted but not up yet (the app just opened
 *   the team): "Connecting…", never a transient "Offline · 1 min" that
 *   flips to "4/4 online" a quarter second later (QA 2.6.1).
 * - **Solo:** a team of one reads "Only you", and the chips offer Invite.
 *
 * Ages are banded the way the map bands them (`ageBand`), never continuous.
 */
import { formatDistance, type Units } from '@core/format';
import { ageBand, FRESH_MS, rangeAndBearing, shortAge, type AgeBand } from './positions';

export type SyncState = 'lan' | 'look' | 'pending' | 'off';

export interface BarMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  isMe: boolean;
  active: boolean;
  /** The last op from them this phone holds, or null. */
  lastSeenAt: number | null;
}

export interface BarPosition {
  id: string;
  lat: number;
  lon: number;
  ageMs: number;
}

export interface BarInputs {
  name: string;
  members: readonly BarMember[];
  positions: readonly BarPosition[];
  /** Members with an open sync session now. */
  connected: ReadonlySet<string>;
  meshRunning: boolean;
  /** The mesh is wanted (foreground, a team open) but has not started yet. */
  meshStarting?: boolean;
  now: number;
}

export interface BarFace {
  id: string;
  initials: string;
  color: string;
  band: AgeBand;
}

export interface TeamBarSummary {
  name: string;
  /** Active members, me included. */
  total: number;
  online: number;
  solo: boolean;
  /** Up to three teammates, freshest first. */
  faces: BarFace[];
  sync: SyncState;
  /** Minutes since the last word from anyone, while offline (null: never heard). */
  offlineMin: number | null;
  /** The pill's second line: "4/6 online", "Only you", "Offline · 12 min". */
  status: string;
  /** What a screen reader says for the pill. */
  a11y: string;
}

/** How long ago a teammate was last heard of (ms), or null when never. */
export function memberAgeMs(
  m: Pick<BarMember, 'id' | 'lastSeenAt'>,
  pos: Pick<BarPosition, 'ageMs'> | undefined,
  connected: ReadonlySet<string>,
  now: number,
): number | null {
  const ages: number[] = [];
  if (connected.has(m.id)) ages.push(0);
  if (pos) ages.push(Math.max(0, pos.ageMs));
  if (m.lastSeenAt !== null) ages.push(Math.max(0, now - m.lastSeenAt));
  return ages.length === 0 ? null : Math.min(...ages);
}

const SYNC_WORDS: Record<SyncState, string> = {
  lan: 'syncing nearby',
  look: 'looking for teammates',
  pending: 'connecting',
  off: 'not syncing',
};

export function teamBarSummary(i: BarInputs): TeamBarSummary {
  const active = i.members.filter((m) => m.active);
  const others = active.filter((m) => !m.isMe);
  const byPos = new Map(i.positions.map((p) => [p.id, p]));
  const aged = others.map((m) => ({ m, age: memberAgeMs(m, byPos.get(m.id), i.connected, i.now) }));
  const NEVER = Number.MAX_SAFE_INTEGER;
  aged.sort((a, b) => (a.age ?? NEVER) - (b.age ?? NEVER) || (a.m.name < b.m.name ? -1 : 1));
  const faces = aged.slice(0, 3).map(({ m, age }) => ({
    id: m.id,
    initials: m.initials,
    color: m.color,
    band: age === null ? ('lost' as const) : ageBand(age),
  }));
  const online = 1 + aged.filter((a) => a.age !== null && a.age <= FRESH_MS).length;
  const total = Math.max(1, active.length);
  const solo = others.length === 0;
  const sync: SyncState = !i.meshRunning
    ? i.meshStarting === true
      ? 'pending'
      : 'off'
    : i.connected.size > 0
      ? 'lan'
      : 'look';
  const heard = aged.map((a) => a.age).filter((a): a is number => a !== null);
  const offlineMin =
    sync === 'off' && heard.length > 0 ? Math.floor(Math.min(...heard) / 60_000) : null;
  const status = solo
    ? 'Only you'
    : sync === 'pending'
      ? 'Connecting…'
      : sync === 'off'
        ? offlineMin === null
          ? 'Offline'
          : `Offline · ${offlineMin} min`
        : `${online}/${total} online`;
  const a11y = solo
    ? `${i.name}: only you, ${SYNC_WORDS[sync]}. Opens the team panel`
    : sync === 'pending'
      ? `${i.name}: connecting. Opens the team panel`
      : sync === 'off'
        ? `${i.name}: ${status}. Opens the team panel`
        : `${i.name}: ${online} of ${total} online, ${SYNC_WORDS[sync]}. Opens the team panel`;
  return { name: i.name, total, online, solo, faces, sync, offlineMin, status, a11y };
}

export interface PanelMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  band: AgeBand;
  ageMs: number | null;
  /** "Live", "Live · 1 min ago", "Last seen 8 min ago", "Lost · 34 min", "Not seen yet". */
  line: string;
  /** From me, when both positions are known. */
  distanceM: number | null;
  compass: string | null;
  /** Their position is a last known one, not live. */
  lastPosition: boolean;
}

const BAND_RANK: Record<AgeBand, number> = { fresh: 0, stale: 1, lost: 2 };

/**
 * The panel's members (not me): live first, nearest first among them, then
 * the stale and the lost, most recently heard of first.
 */
export function panelMembers(
  members: readonly BarMember[],
  positions: readonly BarPosition[],
  connected: ReadonlySet<string>,
  here: { latitude: number; longitude: number } | null,
  now: number,
): PanelMember[] {
  const byPos = new Map(positions.map((p) => [p.id, p]));
  const rows = members
    .filter((m) => m.active && !m.isMe)
    .map((m): PanelMember => {
      const pos = byPos.get(m.id);
      const age = memberAgeMs(m, pos, connected, now);
      const band: AgeBand = age === null ? 'lost' : ageBand(age);
      const rb = pos && here ? rangeAndBearing(here, pos) : null;
      const ago = age === null ? '' : shortAge(age);
      const line =
        age === null
          ? 'Not seen yet'
          : band === 'fresh'
            ? ago === 'now'
              ? 'Live'
              : `Live · ${ago} ago`
            : band === 'stale'
              ? `Last seen ${ago} ago`
              : `Lost · ${ago}`;
      return {
        id: m.id,
        name: m.name,
        initials: m.initials,
        color: m.color,
        band,
        ageMs: age,
        line,
        distanceM: rb ? rb.meters : null,
        compass: rb ? rb.compass : null,
        lastPosition: pos !== undefined && band !== 'fresh',
      };
    });
  // Finite stand-ins for "unknown" so the comparator never yields NaN.
  const FAR = Number.MAX_SAFE_INTEGER;
  return rows.sort(
    (a, b) =>
      BAND_RANK[a.band] - BAND_RANK[b.band] ||
      (a.band === 'fresh' ? (a.distanceM ?? FAR) - (b.distanceM ?? FAR) : 0) ||
      (a.ageMs ?? FAR) - (b.ageMs ?? FAR) ||
      (a.name < b.name ? -1 : 1),
  );
}

/**
 * A teammate's range in the user's units (#702), glance-short: "640 m",
 * "1.2 km", "12 km"; "0.8 mi", "2.1 NM".
 */
export function distanceText(m: number, units: Units): string {
  return formatDistance(m, units, { style: 'short' });
}
