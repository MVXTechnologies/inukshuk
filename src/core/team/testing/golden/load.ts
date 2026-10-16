/** TEST-ONLY: refold a recorded team log as one of its viewers (golden gate, 2.7.0 PR G1). */
import { fromB64u } from '../../bytes';
import type { DeviceKeys } from '../../crypto';
import { TeamReplica } from '../../replica';
import { mulberry32, shuffle } from '../prop';
import { c } from '../fixtures';

import { canonicalText } from './canon';
import type { RecordedLog } from './teamLog26';

export type Viewer = keyof RecordedLog['viewers'];
export const VIEWERS: readonly Viewer[] = ['owner', 'guest', 'removed'];

export function viewerKeys(log: RecordedLog, v: Viewer): DeviceKeys {
  const k = log.viewers[v];
  const get = (s: string) => {
    const b = fromB64u(s);
    if (b === undefined) throw new Error('bad fixture key');
    return b;
  };
  return {
    signSecret: get(k.signSecret),
    signPublic: get(k.signPublic),
    boxSecret: get(k.boxSecret),
    boxPublic: get(k.boxPublic),
  };
}

export type Replay = 'batch' | 'one-by-one' | 'shuffled';
export const REPLAYS: readonly Replay[] = ['batch', 'one-by-one', 'shuffled'];

/**
 * A fresh replica for viewer `v` that ingested the whole log, in one batch,
 * op by op (reading the view between ops, so the incremental data path
 * runs), or op by op in a seeded shuffle (out-of-order arrivals, gap buffer,
 * quarantine, coalesced refolds).
 */
export function replay(
  log: RecordedLog,
  v: Viewer,
  how: Replay,
  seed = 1,
  make: (keys: DeviceKeys) => TeamReplica = (keys) => new TeamReplica(c, log.teamId, keys),
): TeamReplica {
  const r = make(viewerKeys(log, v));
  if (how === 'batch') {
    r.ingest(log.envs, log.now);
    return r;
  }
  const envs = how === 'shuffled' ? shuffle(log.envs, mulberry32(seed)) : log.envs;
  envs.forEach((env, i) => {
    // Stay within the coalescing window now and then, so both refold paths run.
    const at = log.now - 60_000 + i * 397;
    r.ingest([env], Math.min(at, log.now));
    r.data(Math.min(at, log.now));
  });
  return r;
}

/** The canonical text of the replica's view at the log's fold time. */
export function viewText(r: TeamReplica, now: number): string {
  const data = r.data(now);
  return canonicalText(r.state, data);
}
