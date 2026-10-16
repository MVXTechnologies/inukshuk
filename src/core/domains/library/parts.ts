import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { recordKey } from '@core/group/registry';

import { LPT } from './kinds';
import { partId, splitParts } from './trackCodec';
import type { SetBody } from './writes';

/**
 * A trail's `lpt` parts (2.7.0 #712): the bodies a phone writes for one
 * revision of a trail's geometry, and the geometry reassembled, in order,
 * once every part of that revision is in.
 */

/** The `e.set` bodies of every part of `rev` (write them before the trail's `lit`). */
export function partBodies(itemRid: string, rev: string, encoded: string): SetBody[] {
  const parts = splitParts(encoded);
  return parts.map((d, n) => ({
    k: LPT,
    id: partId(rev, n),
    f: { i: itemRid, r: rev, n, of: parts.length, d },
  }));
}

/** Whether part `n` of `rev` is already in the group (written once: never written again). */
export function hasPart(data: Readonly<TeamData>, rev: string, n: number): boolean {
  return data.entities.has(recordKey(false, LPT, partId(rev, n)));
}

/**
 * The encoded trail of item `itemRid` at revision `rev` with `count` parts,
 * or undefined while a part is missing (or one was written for another item:
 * a part names its item, so a revision id cannot be borrowed).
 */
export function assembleTrack(
  data: Readonly<TeamData>,
  itemRid: string,
  rev: string,
  count: number,
): string | undefined {
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const rec = data.entities.get(recordKey(false, LPT, partId(rev, n)));
    if (rec === undefined || !isLive(rec.state)) return undefined;
    const f = visibleFields(rec.state);
    if (f['i'] !== itemRid || f['r'] !== rev || f['n'] !== n || f['of'] !== count) return undefined;
    const d = f['d'];
    if (typeof d !== 'string') return undefined;
    out.push(d);
  }
  return out.join('');
}
