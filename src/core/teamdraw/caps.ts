import { compareStamp } from '@core/team/hlc';
import { isLive, own, type EntityState } from '@core/team/crdt';
import type { Json } from '@core/team/canonical';
import { entityKey, type TeamData } from '@core/team/data';

import { CAP_EXPIRES, CAP_VERSION, PEN_CAP, PEN_PROTOCOL } from './record';

/**
 * Capability records (#683). The handshake frames are strict-keyed, so a new
 * field there would break older peers; instead each 2.5.2+ phone writes one
 * logged `e.set { k: 'cap', id: <its member id>, f: { pen: 1, v, x } }`.
 * Older peers skip the unknown kind silently (chain intact, relayed onwards),
 * whatever its fields. The sync session sends `pen` only to a peer whose
 * member has a current `cap.pen` (`SyncStore.canReceive`), relays included,
 * and never over a third-party relay.
 *
 * A capability is a claim about the software on a phone, and a phone can be
 * rolled back (2.5.2 → 2.5.1) without retracting it; 2.5.1 strikes on `pen`
 * and bans the drawer. So the claim carries the pen protocol version (`v`)
 * and an expiry (`x`, at most {@link CAP_TTL_MS} after its own stamp). A
 * 2.5.2+ phone renews it on each team open (at most once per
 * {@link CAP_RENEW_MS}); an expired or unversioned claim counts as absent.
 */
export { PEN_CAP };

/**
 * The receipts capability (#708, 2.6.1): this phone writes a receipt (`rcp`)
 * for every teammate's SOS and rally point it syncs. Its value is the receipt
 * protocol version. The raiser counts "N of M received" over the members that
 * advertise it, so 2.6.0 and older phones (which never send one) are not
 * counted as missing. Rides the same record as `pen` (older folds accept any
 * extra non-negative integer field, `validCapFields`).
 */
export const RECEIPT_CAP = 'rc';
/** The receipt protocol this version speaks (the value of `rc`). */
export const RECEIPT_PROTOCOL = 1;

/**
 * The notes capability (#706, 2.7.0): this phone shows a pin's note and
 * writes a "seen" receipt (`pnr`) when it opens one. Its value is the notes
 * protocol version. "Seen by 4 of 5" counts over the members that advertise
 * it, so a 2.6 phone (which shows the note as a plain pin and never sends a
 * receipt) is not counted as missing. Rides the same record as `pen`.
 */
export const NOTE_CAP = 'nt';
/** The notes protocol this version speaks (the value of `nt`). */
export const NOTE_PROTOCOL = 1;

/** How long a capability claim holds without being renewed. */
export const CAP_TTL_MS = 7 * 24 * 3600_000;
/** A claim older than this is renewed on the next team open. */
export const CAP_RENEW_MS = 24 * 3600_000;

/** The entity key of `member`'s capability record. */
export function capKey(member: string): string {
  return entityKey('cap', member, member);
}

/** A field's value and stamp wall, when it is visible (written after the newest delete). */
function visible(rec: EntityState, field: string): { value: Json; wall: number } | undefined {
  const reg = own(rec.fields, field);
  if (reg === undefined) return undefined;
  if (rec.deleted !== undefined && compareStamp(reg.stamp, rec.deleted) <= 0) return undefined;
  return { value: reg.value, wall: reg.stamp.wall };
}

/**
 * How a claim of one capability is read (generalised in 2.7.0 from the
 * hard-coded pen and receipt rules; `docs/design/sync-layer.md` §6).
 */
export interface CapSpec {
  /** The protocol versions of this capability this phone speaks: the claim must name one. */
  readonly versions: readonly number[];
  /**
   * The field holding the version, when it is not the flag itself: `pen`
   * keeps its 2.5.2 shape (`pen: 1`, `v: <version>`). Every later capability
   * writes its version as the flag's value (`rc: 1`, `lnk: 1`…).
   */
  readonly versionField?: string;
  /**
   * Also bound the claim by the flag's own stamp (the rollback rule): a phone
   * rolled back to a version without the capability keeps renewing `x`, never
   * the flag, so its old claim lapses within {@link CAP_TTL_MS}. `pen` predates
   * the rule (every version since 2.5.2 renews it).
   */
  readonly boundByFlag: boolean;
}

/** Multiplexed links (2.7.0 G2/G5): channels and lanes over one connection. */
export const LINK_CAP = 'lnk';
/** WebRTC signalling frames inside a session (2.7.0 G2/G6). */
export const RTC_CAP = 'rtc';
/** Blob channels (2.7.x). */
export const BLOB_CAP = 'blob';

/** The link-layer protocol this version speaks (the value of `lnk`). */
export const LINK_PROTOCOL = 1;
/** The WebRTC signalling protocol this version speaks (the value of `rtc`, G6). */
export const RTC_PROTOCOL = 1;

/**
 * Every capability this phone reads, by name. A name not here is never held
 * (fail closed). Advertising one is separate ({@link advertisedCapBody}):
 * 2.7.0 reads `lnk` / `rtc` / `blob` claims and makes `lnk` (G5) and `rtc` (G6).
 */
export const CAP_SPECS: ReadonlyMap<string, CapSpec> = new Map<string, CapSpec>([
  [PEN_CAP, { versions: [PEN_PROTOCOL], versionField: CAP_VERSION, boundByFlag: false }],
  [RECEIPT_CAP, { versions: [RECEIPT_PROTOCOL], boundByFlag: true }],
  [NOTE_CAP, { versions: [NOTE_PROTOCOL], boundByFlag: true }],
  [LINK_CAP, { versions: [1], boundByFlag: true }],
  [RTC_CAP, { versions: [1], boundByFlag: true }],
  [BLOB_CAP, { versions: [1], boundByFlag: true }],
]);

const speaks = (spec: CapSpec, v: Json | undefined) =>
  typeof v === 'number' && spec.versions.includes(v);

/**
 * Until when `member`'s claim of `cap` holds (exclusive), or `undefined` when
 * there is none: no live record, an unknown capability, the flag off, not a
 * version of it this phone speaks, or no expiry. The expiry is capped at the
 * claim's own stamp plus {@link CAP_TTL_MS}: a claim cannot outlive the rule on
 * its writer's say-so (and at the flag's stamp plus the TTL when the spec says so).
 */
export function capExpiry(
  data: TeamData,
  member: string,
  cap: string = PEN_CAP,
  spec: CapSpec | undefined = CAP_SPECS.get(cap),
): number | undefined {
  if (spec === undefined) return undefined;
  const rec = data.entities.get(capKey(member));
  if (rec === undefined || !isLive(rec.state)) return undefined;
  const flag = visible(rec.state, cap);
  const x = visible(rec.state, CAP_EXPIRES);
  // Only a number gets past the fold's `validCapFields`; anything else is no claim.
  if (x === undefined || typeof x.value !== 'number' || flag === undefined) return undefined;
  if (spec.versionField === undefined) {
    if (!speaks(spec, flag.value)) return undefined;
  } else if (flag.value !== 1 || !speaks(spec, visible(rec.state, spec.versionField)?.value)) {
    return undefined;
  }
  const until = Math.min(x.value, x.wall + CAP_TTL_MS);
  return spec.boundByFlag ? Math.min(until, flag.wall + CAP_TTL_MS) : until;
}

/** Whether `member` advertises `cap` at `now` (a live, current, unexpired claim). */
export function hasCap(
  data: TeamData,
  member: string,
  now: number,
  cap: string = PEN_CAP,
): boolean {
  const until = capExpiry(data, member, cap);
  return until !== undefined && now < until;
}

/** The members advertising a capability at a time, and until when that set holds. */
export interface CapHolders {
  holders: Set<string>;
  /** The first expiry among them (exclusive): from then on, scan again. */
  validUntil: number;
}

/**
 * Every member advertising `cap` at `now`, in one pass over the fold (the
 * replica caches this per data change and until the first expiry, so the
 * sync session's per-stroke gate is a set lookup).
 */
export function capHolders(data: TeamData, now: number, cap: string = PEN_CAP): CapHolders {
  const holders = new Set<string>();
  let validUntil = Infinity;
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'cap') continue;
    const until = capExpiry(data, rec.id, cap);
    if (until === undefined || now >= until) continue;
    holders.add(rec.id);
    validUntil = Math.min(validUntil, until);
  }
  return { holders, validUntil };
}

/** The body this device writes to advertise what it understands, until `now` + the TTL. */
export function capBody(
  me: string,
  now: number,
): { k: 'cap'; id: string; f: Record<string, Json> } {
  return {
    k: 'cap',
    id: me,
    f: {
      [PEN_CAP]: 1,
      [CAP_VERSION]: PEN_PROTOCOL,
      [RECEIPT_CAP]: RECEIPT_PROTOCOL,
      [CAP_EXPIRES]: now + CAP_TTL_MS,
    },
  };
}

/**
 * The record a 2.7.0 phone writes: the 2.6 body ({@link capBody}, which is
 * what every older phone writes, kept as is for their fixtures) plus `lnk`,
 * the LAN upgrade to link-mux framing (design §2.6), and `rtc`, WebRTC
 * signalling inside a session (R-RTC-1), and `nt`, notes and their "seen"
 * receipts (#706, G8). A rolled-back phone renews `pen`/`v`/`rc`/`x` without
 * them, so its claims lapse (`boundByFlag`).
 */
export function advertisedCapBody(
  me: string,
  now: number,
): { k: 'cap'; id: string; f: Record<string, Json> } {
  const body = capBody(me, now);
  return {
    ...body,
    f: {
      ...body.f,
      [LINK_CAP]: LINK_PROTOCOL,
      [RTC_CAP]: RTC_PROTOCOL,
      [NOTE_CAP]: NOTE_PROTOCOL,
    },
  };
}

/**
 * {@link needsCap} for a 2.7.0 phone: also when its `lnk`, `rtc` or `nt`
 * claim is missing or stale (a 2.6 claim, or a G5 build's `lnk`-only one,
 * renews at once on the first open).
 */
export function needsAdvertisedCap(data: TeamData, me: string, now: number): boolean {
  if (needsCap(data, me, now)) return true;
  return [LINK_CAP, RTC_CAP, NOTE_CAP].some((cap) => {
    const until = capExpiry(data, me, cap);
    return until === undefined || until - now < CAP_TTL_MS - CAP_RENEW_MS;
  });
}

/**
 * Whether this device has to (re-)advertise: no current claim of either
 * capability (a 2.6.0 claim has no `rc`: renewed at once on the first 2.6.1
 * open), or one older than {@link CAP_RENEW_MS} (renewing on every open would
 * grow the log for nothing).
 */
export function needsCap(data: TeamData, me: string, now: number): boolean {
  const stale = (until: number | undefined) =>
    until === undefined || until - now < CAP_TTL_MS - CAP_RENEW_MS;
  return stale(capExpiry(data, me)) || stale(capExpiry(data, me, RECEIPT_CAP));
}
