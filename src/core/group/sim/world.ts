import { addMemberBody, createTeam, targetOf } from '../../team/actions';
import { concatBytes, toB64u, utf8 } from '../../team/bytes';
import { canonicalize } from '../../team/canonical';
import { generateDeviceKeys, type TeamCrypto } from '../../team/crypto';
import { memberIdOf } from '../../team/ids';
import { TeamReplica } from '../../team/replica';
import { LINK_CAP, RTC_CAP } from '../../team/sync';
import type { PathKind } from '../path';
import { SimClock } from './clock';
import { SimNetwork, type SimConn } from './network';
import { SimPhone, type AppVersion, type PhoneHost } from './phone';
import { seeded, seededCrypto, type Rng } from './rng';

/** 2026-10-16T08:00Z: the simulator's epoch. */
export const SIM_T0 = Date.UTC(2026, 9, 16, 8);
/** Period of every phone's tick (re-sync vectors, keepalives, timeouts). */
export const TICK_MS = 10_000;

export interface WorldOptions {
  seed: number;
  /** The real crypto to run (its random bytes are replaced by the seed's). */
  base: TeamCrypto;
  /** One entry per phone. Phone 0 owns group 0, phone 1 owns group 1. */
  phones: readonly AppVersion[];
  /** 1 (default) or 2. Group 1 has only the 2.7 phones (a 2.6 phone runs one team). */
  groups?: 1 | 2;
  /** Keep every wire frame (plaintext scans, padding checks, digest). Default true. */
  keepWire?: boolean;
}

export interface Convergence {
  ok: boolean;
  detail: string;
}

/**
 * A deterministic world of phones (design §8.1): seeded crypto, a virtual
 * clock, a network with latency, loss, reordering and partitions, and
 * groups whose members all hold the opening log (an in-person start).
 */
export class SimWorld implements PhoneHost {
  readonly rnd: Rng;
  readonly c: TeamCrypto;
  readonly clock: SimClock;
  readonly net: SimNetwork;
  readonly phones: SimPhone[] = [];
  readonly groupIds: string[] = [];
  private readonly versions = new Map<string, AppVersion>();
  private ticking = false;

  constructor(readonly options: WorldOptions) {
    this.rnd = seeded(options.seed);
    this.c = seededCrypto(options.base, seeded(options.seed ^ 0x5eed));
    this.clock = new SimClock(SIM_T0);
    this.net = new SimNetwork(this.clock, this.rnd, options.keepWire ?? true);
    options.phones.forEach((version, i) => {
      const keys = generateDeviceKeys(this.c);
      const id = memberIdOf(keys.signPublic);
      this.versions.set(id, version);
      this.phones.push(new SimPhone(this, `p${i}`, keys, id, version));
    });
    this.makeGroup(this.phones[0]!, this.phones);
    if ((options.groups ?? 1) === 2) {
      const owner = this.phones[1] ?? this.phones[0]!;
      this.makeGroup(
        owner,
        this.phones.filter((p) => p.version === '2.7'),
      );
    }
  }

  claims(member: string): readonly string[] {
    return this.versions.get(member) === '2.7' ? [LINK_CAP, RTC_CAP] : [];
  }

  private makeGroup(owner: SimPhone, members: readonly SimPhone[]): string {
    const now = this.clock.now;
    const team = createTeam(this.c, owner.keys, now);
    const root = new TeamReplica(this.c, team.teamId, owner.keys, team.writer.cursor);
    root.addKey(team.key);
    root.ingest([team.genesis.env], now);
    for (const m of members) {
      if (m === owner) continue;
      root.control(
        now,
        'm.add',
        addMemberBody(
          this.c,
          team.teamId,
          targetOf({ id: m.id, x: toB64u(m.keys.boxPublic) }),
          'member',
          root.sendKey()!,
        ),
      );
    }
    const envs = root.log.logged().map((op) => op.env);
    owner.join(team.teamId, root);
    for (const m of members) {
      if (m === owner) continue;
      const r = new TeamReplica(this.c, team.teamId, m.keys);
      r.ingest(envs, now);
      m.join(team.teamId, r);
    }
    this.groupIds.push(team.teamId);
    return team.teamId;
  }

  /** Connect two phones over `path`; `a` dials. */
  link(a: SimPhone, b: SimPhone, path: PathKind): SimConn {
    const conn = this.net.connect(a, b, path);
    a.attach(conn, 'initiator', b);
    b.attach(conn, 'responder', a);
    return conn;
  }

  /** Tick every phone every {@link TICK_MS}, staggered by phone. */
  startTicks(): void {
    if (this.ticking) return;
    this.ticking = true;
    this.phones.forEach((p, i) => {
      const loop = () => {
        p.tick();
        this.clock.after(TICK_MS, loop);
      };
      this.clock.after(1000 + i * 937, loop);
    });
  }

  run(ms: number): void {
    this.clock.runUntil(this.clock.now + ms);
  }

  holders(groupId: string): SimPhone[] {
    return this.phones.filter((p) => p.groups.has(groupId));
  }

  /** Whether every replica of `groupId` holds the same log, vector and entities. */
  convergence(groupId: string): Convergence {
    const snaps = this.holders(groupId).map((p) => {
      const r = p.groups.get(groupId)!;
      return {
        name: p.name,
        vv: canonicalize(r.versionVector())!,
        ops: r.log
          .logged()
          .map((op) => op.id)
          .sort()
          .join(','),
        entities: [...r.data().entities.keys()].sort().join(','),
      };
    });
    const first = snaps[0];
    for (const s of snaps.slice(1)) {
      for (const key of ['vv', 'ops', 'entities'] as const) {
        if (s[key] !== first![key]) {
          return { ok: false, detail: `${s.name} ≠ ${first!.name} on ${key}` };
        }
      }
    }
    return { ok: true, detail: `${snaps.length} replicas agree` };
  }

  /** A digest of every frame on the wire, with its time and sender: equal digests = identical runs. */
  wireDigest(): string {
    const parts: Uint8Array[] = [];
    for (const w of this.net.wire) parts.push(utf8(`${w.connId}|${w.from}|${w.at}|`), w.data);
    const all = concatBytes(...parts);
    return toB64u(this.c.sha256(all));
  }
}
