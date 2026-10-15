import {
  choosePath,
  DEFAULT_PATH_POLICY,
  PATH_KINDS,
  type PathDecision,
  type PathKind,
  type PathStatus,
  type PeerPaths,
} from '../path';
import type { SimConn } from './network';
import type { SimPhone } from './phone';
import { randInt } from './rng';
import type { SimWorld } from './world';

/** What the simulated environment allows between two phones right now. */
export interface PairEnv {
  /** Same Wi-Fi or hotspot. */
  nearby: boolean;
  /** Both phones online and in the group's room. */
  online: boolean;
  /** NATs allow a direct (srflx) path. */
  directWorks: boolean;
  /** Either phone has "Always use the relay" on. */
  alwaysRelay: boolean;
}

/**
 * A minimal `PathManager` for one pair of 2.7 phones (design §2.5), driven
 * by the pure {@link choosePath}: it observes the connections, asks for a
 * decision every second, and dials, closes and ICE-restarts as told. The
 * initiator is the phone with the lower name (as the lower room handle).
 */
export class SimPathDriver {
  readonly conns: Partial<Record<PathKind, SimConn>> = {};
  private status: Partial<Record<PathKind, PathStatus>> = {};
  primary: PathKind | undefined;
  private directAttemptAt: number | undefined;
  private lastDirectTryAt: number | undefined;
  /** The attempt in progress per internet path (a newer one cancels an older one's callbacks). */
  private readonly attempts: Record<'direct' | 'relay', number> = { direct: 0, relay: 0 };
  /** Decisions taken (for assertions). */
  readonly log: { at: number; decision: PathDecision }[] = [];
  private stopped = false;

  constructor(
    private readonly world: SimWorld,
    readonly a: SimPhone,
    readonly b: SimPhone,
    public env: PairEnv,
  ) {}

  start(periodMs = 1000): void {
    const loop = () => {
      if (this.stopped) return;
      this.step();
      this.world.clock.after(periodMs, loop);
    };
    this.world.clock.after(0, loop);
  }

  stop(): void {
    this.stopped = true;
  }

  private open(kind: PathKind): SimConn | undefined {
    const c = this.conns[kind];
    if (c !== undefined && !c.open) {
      delete this.conns[kind];
      if (this.status[kind]?.state === 'ready') delete this.status[kind];
      return undefined;
    }
    return c;
  }

  private lastHeard(kind: PathKind): number | undefined {
    const conn = this.conns[kind];
    if (conn === undefined) return undefined;
    const link = this.a.links.get(conn.id);
    return link?.kind === 'mux' ? link.mux.lastHeard : undefined;
  }

  step(): void {
    const now = this.world.clock.now;
    // Observe.
    for (const k of PATH_KINDS) {
      const c = this.open(k);
      const s = this.status[k];
      if (c !== undefined && s !== undefined && s.state === 'ready') {
        s.lastHeard = Math.max(s.lastHeard, this.lastHeard(k) ?? s.lastHeard);
      }
    }
    // The LAN comes and goes with the environment, not with the policy.
    if (this.env.nearby && this.open('nearby') === undefined) this.connect('nearby');
    if (!this.env.nearby && this.open('nearby') !== undefined) this.drop('nearby');
    if (!this.env.online) {
      for (const k of ['direct', 'relay'] as const) if (this.open(k) !== undefined) this.drop(k);
    }
    const peer: PeerPaths = {
      paths: { ...this.status },
      primary: this.primary,
      signalling: this.env.online,
      directAttemptAt: this.directAttemptAt,
      lastDirectTryAt: this.lastDirectTryAt,
    };
    const policy = { ...DEFAULT_PATH_POLICY, alwaysRelay: this.env.alwaysRelay };
    const d = choosePath(peer, policy, now);
    this.log.push({ at: now, decision: d });
    this.primary = d.primary;
    for (const k of d.close) this.drop(k);
    for (const k of d.dial) this.dial(k);
    if (d.iceRestart) this.dial('direct');
  }

  private connect(kind: PathKind): void {
    const conn = this.world.link(this.a, this.b, kind);
    this.conns[kind] = conn;
    const now = this.world.clock.now;
    this.status[kind] = { state: 'ready', since: now, lastHeard: now };
  }

  private drop(kind: PathKind): void {
    const c = this.conns[kind];
    if (c !== undefined) this.world.net.cut(c, 'path-closed');
    delete this.conns[kind];
    delete this.status[kind];
  }

  private dial(kind: 'direct' | 'relay'): void {
    const now = this.world.clock.now;
    const attempt = ++this.attempts[kind];
    this.status[kind] = { state: 'connecting', since: now, lastHeard: now };
    if (kind === 'direct') {
      this.directAttemptAt = now;
      this.lastDirectTryAt = now;
    }
    const delay = randInt(this.world.rnd, 300, 2500);
    this.world.clock.after(delay, () => {
      if (this.stopped || this.attempts[kind] !== attempt) return;
      if (this.status[kind]?.state !== 'connecting') return;
      const works =
        this.env.online && (kind === 'relay' || (this.env.directWorks && !this.env.alwaysRelay));
      if (works) {
        if (kind === 'direct') this.directAttemptAt = undefined;
        this.connect(kind);
        return;
      }
      // ICE never completes: the attempt fails at its timeout.
      const left = kind === 'direct' ? Math.max(0, DEFAULT_PATH_POLICY.directTimeoutMs - delay) : 0;
      this.world.clock.after(left, () => {
        if (this.attempts[kind] !== attempt || this.status[kind]?.state !== 'connecting') return;
        this.status[kind] = {
          state: 'failed',
          since: this.world.clock.now,
          lastHeard: this.world.clock.now,
        };
        if (kind === 'direct') this.directAttemptAt = undefined;
      });
    });
  }

  /** Live connections between the pair. */
  live(): SimConn[] {
    return PATH_KINDS.map((k) => this.open(k)).filter((c): c is SimConn => c !== undefined);
  }
}
