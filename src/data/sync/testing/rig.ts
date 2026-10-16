/**
 * Test rig for the data-layer sync tests (G5): phones on one loopback hub
 * with a manual work queue, a manual clock and manual timers, so a run is
 * the same every time and nothing waits on the wall clock. `settle()` runs
 * queued deliveries and promise continuations until nothing is left.
 *
 * `Phone26` is a 2.6.x phone, built from the code 2.6 runs: it joins through
 * `JoinAttempt`, then syncs with `MeshSessionHost` + `MeshLink` and push-mode
 * `SyncSession`s (sealed at once, raw v1 framing), and advertises the 2.6
 * capability record (`pen`, `rc`; no `lnk`).
 */
import { lanDiscoveryTag } from '@core/mesh/tag';
import { generateDeviceKeys, type TeamCrypto } from '@core/team/crypto';
import type { SignedOp } from '@core/team/envelope';
import type { InviteToken } from '@core/team/invite';
import { SyncSession, type SessionEvent } from '@core/team/sync';
import { capBody } from '@core/teamdraw/caps';
import { TEAM_THREAD } from '@core/teamui/view';

import { LoopbackMeshHub } from '@data/team/loopbackMesh';
import { MeshLink } from '@data/team/meshLink';
import { MeshSessionHost } from '@data/team/meshSessions';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import { JoinAttempt } from '@data/team/teamJoin';

import type { Timers } from '../linkHost';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

const flushPromises = () => new Promise<void>((r) => setImmediate(r));

export class Rig {
  t = 1_790_000_000_000;
  private readonly queue: (() => void)[] = [];
  private readonly timerList: Timer[] = [];
  private nextTimer = 1;
  /** Hub deliveries run so far (a measure of work, never of time). */
  delivered = 0;
  readonly hub: LoopbackMeshHub;
  readonly now = (): number => this.t;

  constructor(options: { maxQueuedBytes?: number; maxFrameBytes?: number } = {}) {
    this.hub = new LoopbackMeshHub({ ...options, schedule: (fn) => this.queue.push(fn) });
  }

  readonly timers: Timers = {
    setTimeout: (fn, ms) => this.addTimer(fn, ms, null),
    clearTimeout: (h) => this.removeTimer(h),
    setInterval: (fn, ms) => this.addTimer(fn, ms, ms),
    clearInterval: (h) => this.removeTimer(h),
  };

  private addTimer(fn: () => void, ms: number, every: number | null): number {
    const id = this.nextTimer++;
    this.timerList.push({ id, at: this.t + Math.max(0, ms), fn, every });
    return id;
  }

  private removeTimer(h: unknown): void {
    const i = this.timerList.findIndex((x) => x.id === h);
    if (i >= 0) this.timerList.splice(i, 1);
  }

  /** Fire every timer due at the current time; true when one fired. */
  private fireDue(): boolean {
    let fired = false;
    for (;;) {
      const due = this.timerList
        .filter((x) => x.at <= this.t)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) return fired;
      if (due.every === null) this.removeTimer(due.id);
      else due.at += due.every;
      fired = true;
      due.fn();
    }
  }

  /** Move the clock (firing timers on the way, in order). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timerList
        .filter((x) => x.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (next === undefined) break;
      this.t = Math.max(this.t, next.at);
      this.fireDue();
    }
    this.t = end;
  }

  /**
   * Run hub deliveries and promise continuations until both are idle. The
   * clock moves 5 ms per idle round while pacing timers are pending (links
   * pace their frames by the peer's limits), at most `maxRounds` rounds.
   */
  async settle(maxRounds = 5_000): Promise<void> {
    let idle = 0;
    for (let round = 0; round < maxRounds; round++) {
      const batch = this.queue.splice(0);
      for (const fn of batch) {
        this.delivered++;
        fn();
      }
      await flushPromises();
      if (this.queue.length > 0) {
        idle = 0;
        continue;
      }
      if (this.fireDue()) continue;
      const pacing = this.timerList.some((x) => x.every === null);
      if (pacing) {
        this.advance(5);
        continue;
      }
      if (++idle >= 3) return;
    }
    throw new Error('the rig did not settle');
  }
}

/** A 2.6.x phone: the 2.6 join, session host, discovery and push-mode sessions. */
export class Phone26 {
  readonly disk = new MemoryTeamDisk();
  readonly transport;
  readonly keys;
  attempt: JoinAttempt | null = null;
  private host: MeshSessionHost<SessionEvent, SyncSession> | null = null;
  private link: MeshLink | null = null;
  /** Every session event this phone saw, by type (strikes above all). */
  readonly events: Record<string, number> = {};
  readonly strikes: string[] = [];
  /** Why its sessions ended. */
  readonly closes: string[] = [];

  constructor(
    private readonly rig: Rig,
    private readonly c: TeamCrypto,
  ) {
    this.transport = rig.hub.createTransport();
    this.keys = generateDeviceKeys(c);
  }

  get replica() {
    return this.attempt!.replica;
  }

  get id(): string {
    return this.replica.id;
  }

  async join(token: InviteToken): Promise<void> {
    this.attempt = new JoinAttempt(
      {
        c: this.c,
        disk: this.disk,
        transport: this.transport,
        now: this.rig.now,
        onChange: () => undefined,
        tickMs: 0,
      },
      token,
      this.keys,
    );
    await this.attempt.start();
    await this.rig.settle();
    if (!this.attempt.admitted) throw new Error('2.6 phone not admitted');
    await this.attempt.stop();
    await this.rig.settle();
  }

  /** Run as 2.6 does: advertise the team, dial teammates, push what is stored. */
  async start(): Promise<void> {
    const store = this.attempt!.store;
    const c = this.c;
    this.host = new MeshSessionHost<SessionEvent, SyncSession>(
      this.transport,
      {
        initiate: () =>
          SyncSession.initiate(c, store, { now: this.rig.now(), carryLiveStrokes: true }),
        respond: () => SyncSession.respond(c, store, { carryLiveStrokes: true }),
      },
      (peerId, event) => {
        this.events[event.type] = (this.events[event.type] ?? 0) + 1;
        if (event.type === 'strike') this.strikes.push(event.reason);
        if (event.type === 'closed') this.closes.push(event.why);
        if (event.type === 'ingested') this.gossip(event.report.accepted, peerId);
        if (event.type === 'admitted') this.gossip([event.op], peerId);
      },
      { now: this.rig.now, tickMs: 0, label: '2.6' },
    );
    store.onStored = (ops) => this.gossip(ops, null);
    this.host.start();
    this.link = new MeshLink(this.transport, {
      tag: lanDiscoveryTag(this.replica.teamId, (d) => c.sha256(d)),
      advertise: true,
      onChange: () => undefined,
    });
    await this.link.start();
  }

  private gossip(ops: readonly SignedOp[], except: string | null): void {
    if (ops.length === 0) return;
    const now = this.rig.now();
    this.host?.forEachOpen((s, peer) =>
      peer.peerId === except ? { send: [], events: [] } : s.push(ops, now),
    );
  }

  /** The 2.6 capability record (pen, receipts; no link mux). */
  advertise(): void {
    const now = this.rig.now();
    this.attempt!.store.track(() => ({
      result: this.replica.write(now, 'e.set', capBody(this.id, now)),
      accepted: [],
    }));
  }

  say(text: string): void {
    const now = this.rig.now();
    this.attempt!.store.track(() => ({
      result: this.replica.write(now, 'msg', { id: `m${now}`, th: TEAM_THREAD, tx: text }),
      accepted: [],
    }));
  }

  tick(): void {
    this.host?.tickAll();
  }

  openSessions(): number {
    return (this.host?.peers() ?? []).filter((p) => p.session.phase === 'open').length;
  }

  async stop(): Promise<void> {
    this.host?.stop('bye');
    await this.link?.stop();
  }
}
