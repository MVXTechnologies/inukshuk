import type { TeamReplica } from '../../team/replica';
import type { SyncStore } from '../../team/sync';

/**
 * A replica seen through {@link SyncStore}, with capability claims supplied
 * by the simulation (`claims(member)`) on top of the logged `cap` records.
 * 2.7 phones in the simulator claim `lnk`/`rtc`; a simulated 2.6 phone claims
 * nothing, exactly as a real one.
 */
export function capStore(r: TeamReplica, claims: (member: string) => readonly string[]): SyncStore {
  return {
    get teamId() {
      return r.teamId;
    },
    keys: r.keys,
    id: r.id,
    get state() {
      return r.state;
    },
    versionVector: () => r.versionVector(),
    opsInRange: (a, from, to) => r.opsInRange(a, from, to),
    liveEphemeral: (now) => r.liveEphemeral(now),
    ingest: (raws, now) => r.ingest(raws, now),
    isActiveMember: (m) => r.isActiveMember(m),
    admit: (proof, now) => r.admit(proof, now),
    flush: (now) => r.flush(now),
    canReceive: (m, cap, now) => claims(m).includes(cap) || r.canReceive(m, cap, now),
  };
}
