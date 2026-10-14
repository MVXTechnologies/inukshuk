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
 * Until when `member`'s claim of `cap` holds (exclusive), or `undefined` when
 * there is none: no live record, the flag off, not the pen protocol this
 * phone speaks, or no expiry. The expiry is capped at the claim's own stamp
 * plus {@link CAP_TTL_MS}: a claim cannot outlive the rule on its writer's say-so.
 */
export function capExpiry(
  data: TeamData,
  member: string,
  cap: string = PEN_CAP,
): number | undefined {
  const rec = data.entities.get(capKey(member));
  if (rec === undefined || !isLive(rec.state)) return undefined;
  const flag = visible(rec.state, cap);
  const v = visible(rec.state, CAP_VERSION);
  const x = visible(rec.state, CAP_EXPIRES);
  if (flag?.value !== 1 || v?.value !== PEN_PROTOCOL) return undefined;
  // Only a number gets past the fold's `validCapFields`; anything else is no claim.
  if (x === undefined || typeof x.value !== 'number') return undefined;
  return Math.min(x.value, x.wall + CAP_TTL_MS);
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
    f: { [PEN_CAP]: 1, [CAP_VERSION]: PEN_PROTOCOL, [CAP_EXPIRES]: now + CAP_TTL_MS },
  };
}

/**
 * Whether this device has to (re-)advertise: no current claim, or one older
 * than {@link CAP_RENEW_MS} (renewing on every open would grow the log for nothing).
 */
export function needsCap(data: TeamData, me: string, now: number): boolean {
  const until = capExpiry(data, me);
  return until === undefined || until - now < CAP_TTL_MS - CAP_RENEW_MS;
}
