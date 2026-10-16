/**
 * Team mode on this phone (#589), as the screens see it: the teams it is in,
 * the one the screens show (the "active" team), and a join in progress. The
 * UI talks to this through `@state/teamStore`; the two-peer tests drive two
 * of these over the loopback hub.
 *
 * Since 2.7.0 (G5) this is a façade over the {@link GroupHost}, which keeps
 * every team loaded and its links carrying every team two phones share. The
 * active team is a UI concept here: its alerts, drawing alerts and receipts
 * reach the screens, and the LAN advertises its tag while sync is on
 * (`TeamSession.startMesh`). Switching teams stops the LAN and the screens
 * start it again for the new one, as in 2.6.
 *
 * One exception (owner decision 2026-10-16): an SOS from ANY of my teams —
 * its raise, reopen and resolve — reaches the alert listeners with its team
 * id, so the full alarm rings and the screens can switch to that team. Every
 * other kind from a team not on screen stays silent.
 */
import type { InviteToken } from '@core/team/invite';
import type { TeamAlert } from '@core/teamui/alerts';
import { cleanName } from '@core/teamui/system';

import { addBreadcrumb } from '@lib/errorReporting';

import { GroupHost, type HostDeps } from '@data/sync/groupHost';

import type { MeshTransport } from './meshTransport';
import type { TeamRecord } from './teamDisk';
import type { JoinAttempt } from './teamJoin';
import type { SessionDrawAlert } from './teamDraw';
import type { ActionError, TeamSession } from './teamSession';

export type ServiceDeps = HostDeps;

export type ServiceListener = () => void;
export type AlertListener = (alert: TeamAlert, teamId: string) => void;
export type DrawAlertListener = (alert: SessionDrawAlert, teamId: string) => void;

/** After a join, report when no teammate link comes up within this long (the joiner flake). */
export const FIRST_LINK_WATCH_MS = 30_000;

export class TeamService {
  /** Every group on this phone and the links between phones. */
  readonly host: GroupHost;
  private activeId: string | null = null;
  private readonly listeners = new Set<ServiceListener>();
  private readonly alertListeners = new Set<AlertListener>();
  private readonly drawListeners = new Set<ServiceListener>();
  private readonly drawAlertListeners = new Set<DrawAlertListener>();
  readonly now: () => number;

  constructor(private readonly deps: ServiceDeps) {
    this.host = new GroupHost(deps, {
      onChange: () => this.emit(),
      onAlert: (alert, teamId) => {
        if (teamId !== this.activeId && alert.kind !== 'sos') return;
        for (const fn of [...this.alertListeners]) fn(alert, teamId);
      },
      onDraw: (teamId) => {
        if (teamId === this.activeId) this.emitDraw();
      },
      onDrawAlert: (alert, teamId) => {
        if (teamId !== this.activeId) return;
        for (const fn of [...this.drawAlertListeners]) fn(alert, teamId);
      },
      foreground: (teamId) => teamId === this.activeId,
    });
    this.now = this.host.now;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  subscribe(fn: ServiceListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onAlert(fn: AlertListener): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  /** Teammates' live strokes changed (#683): its own channel, never `subscribe`'s. */
  onDraw(fn: ServiceListener): () => void {
    this.drawListeners.add(fn);
    return () => this.drawListeners.delete(fn);
  }

  /** A teammate's drawing earned a snackbar or a notification (#683). */
  onDrawAlert(fn: DrawAlertListener): () => void {
    this.drawAlertListeners.add(fn);
    return () => this.drawAlertListeners.delete(fn);
  }

  private emitDraw(): void {
    for (const fn of [...this.drawListeners]) {
      try {
        fn();
      } catch {
        // A UI listener's failure must not break the sync plumbing.
      }
    }
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A UI listener's failure must not break the sync plumbing.
      }
    }
  }

  // ── The team list ────────────────────────────────────────────────────────

  /** Load the team list and every team (the device keys load on first use). */
  load(): Promise<void> {
    return this.host.load();
  }

  get teams(): readonly TeamRecord[] {
    return this.host.teams;
  }

  /** The team to reopen at launch: the one opened last. */
  get lastOpened(): TeamRecord | null {
    let best: TeamRecord | null = null;
    for (const r of this.host.teams) {
      if (best === null || (r.lastOpenedAt ?? r.joinedAt) > (best.lastOpenedAt ?? best.joinedAt))
        best = r;
    }
    return best;
  }

  get active(): TeamSession | null {
    return this.activeId === null ? null : (this.host.open(this.activeId) ?? null);
  }

  get join(): JoinAttempt | null {
    return this.host.join;
  }

  /** The network this phone is on (hotspot fallback hints); null without a mesh. */
  networkInfo(): ReturnType<MeshTransport['networkInfo']> | null {
    return this.host.networkInfo();
  }

  // ── Teams ────────────────────────────────────────────────────────────────

  /** Found a team; it becomes the active one (mesh not started: `startMesh`). */
  async createTeam(options: {
    name: string;
    myName: string;
    lifetimeMs: number;
  }): Promise<TeamSession> {
    const created = await this.host.create(options);
    const session = await this.activate(created.session.teamId);
    session.replica.addKey(created.key);
    session.setMyName(options.myName);
    session.republishIfNewKey();
    return session;
  }

  /** Show a team (stops the LAN advertising the previous one). */
  async activate(teamId: string): Promise<TeamSession> {
    await this.load();
    const current = this.active;
    if (current?.teamId === teamId) return current;
    if (!this.host.teams.some((r) => r.teamId === teamId)) throw new Error('Unknown team');
    const session = await this.host.ensure(teamId);
    await this.deactivate();
    this.activeId = teamId;
    session.updateRecord({ lastOpenedAt: this.now() });
    // A team opened or just joined: advertise live drawing (#683) and the link mux if not yet.
    session.draw.advertise();
    if (session.record.name !== session.view().name) {
      session.updateRecord({ name: session.view().name });
    }
    this.emit();
    return session;
  }

  async deactivate(): Promise<void> {
    const s = this.active;
    this.activeId = null;
    await s?.stopMesh();
    this.emit();
  }

  /**
   * Delete a team from this phone: tell the admins (they remove me and rotate
   * the key), stop its sync, delete its log. What teammates already have stays
   * on their phones; nothing can be wiped remotely.
   */
  async leave(teamId: string): Promise<void> {
    await this.load();
    const s = this.active;
    if (s?.teamId === teamId) {
      s.announceLeave();
      // Give the goodbye a moment to reach whoever is connected.
      s.tick();
      await this.deactivate();
    }
    await this.host.remove(teamId);
    this.emit();
  }

  // ── Joining ──────────────────────────────────────────────────────────────

  /** Start joining with an invite; the active team's sync stops meanwhile. */
  async startJoin(token: InviteToken, myName: string): Promise<JoinAttempt> {
    await this.load();
    if (cleanName(myName) === null) throw new Error('A display name is needed');
    if (this.host.teams.some((r) => r.teamId === token.teamId)) throw new Error('already-member');
    await this.host.cancelJoin();
    await this.deactivate();
    const attempt = await this.host.startJoin(token, myName, this.deps.tickMs);
    this.emit();
    return attempt;
  }

  /** Abandon a join (codes didn't match, or the user gave up): its data is deleted. */
  cancelJoin(): Promise<void> {
    return this.host.cancelJoin();
  }

  /** The codes matched: keep the team, post my name, make it active. */
  async confirmJoin(): Promise<TeamSession | ActionError> {
    const joined = await this.host.confirmJoin();
    if (typeof joined === 'string') return joined;
    const session = await this.activate(joined.teamId);
    addBreadcrumb('team join: confirmed, team session opened');
    session.watchFirstLinkMs = FIRST_LINK_WATCH_MS;
    this.emit();
    return session;
  }
}
