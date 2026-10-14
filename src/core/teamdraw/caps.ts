import { compareStamp } from '@core/team/hlc';
import { isLive, own } from '@core/team/crdt';
import type { Json } from '@core/team/canonical';
import { entityKey, type TeamData } from '@core/team/data';

import { PEN_CAP } from './record';

/**
 * Capability records (#683). The handshake frames are strict-keyed, so a new
 * field there would break older peers; instead each 2.5.2+ phone writes one
 * logged `e.set { k: 'cap', id: <its member id>, f: { pen: 1 } }`. Older
 * peers skip the unknown kind silently (chain intact, relayed onwards). The
 * sync session sends `pen` only to a peer whose member has `cap.pen`
 * (`SyncStore.canReceive`), relays included, and never over a third-party relay.
 */
export { PEN_CAP };

/** The entity key of `member`'s capability record. */
export function capKey(member: string): string {
  return entityKey('cap', member, member);
}

/** Whether `member` advertises `cap` (a live record whose visible flag is 1). */
export function hasCap(data: TeamData, member: string, cap: string = PEN_CAP): boolean {
  const rec = data.entities.get(capKey(member));
  if (rec === undefined || !isLive(rec.state)) return false;
  const reg = own(rec.state.fields, cap);
  if (reg === undefined || reg.value !== 1) return false;
  return rec.state.deleted === undefined || compareStamp(reg.stamp, rec.state.deleted) > 0;
}

/**
 * Every member advertising `cap`, in one pass over the fold (the replica
 * caches this per data change, so the sync session's per-stroke gate is a
 * set lookup).
 */
export function capHolders(data: TeamData, cap: string = PEN_CAP): Set<string> {
  const out = new Set<string>();
  for (const rec of data.entities.values()) {
    if (rec.kind === 'cap' && hasCap(data, rec.id, cap)) out.add(rec.id);
  }
  return out;
}

/** The body this device writes once to advertise what it understands. */
export function capBody(me: string): { k: 'cap'; id: string; f: Record<string, Json> } {
  return { k: 'cap', id: me, f: { [PEN_CAP]: 1 } };
}

/** Whether this device still has to advertise (no live record, or the flag is off). */
export function needsCap(data: TeamData, me: string): boolean {
  return !hasCap(data, me);
}
