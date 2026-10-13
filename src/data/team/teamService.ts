/**
 * Team mode on this phone (#589): the device identity, the teams it is in,
 * the one team whose session runs, and a join in progress. The UI talks to
 * this through `@state/teamStore`; the two-peer tests drive two of these over
 * the loopback hub.
 *
 * v1 runs one team session at a time (the "active" team): its mesh is the
 * only user of the transport. Switching teams stops one mesh and starts the
 * other.
 */
import { toB64u, fromB64uLen } from '@core/team/bytes';
import { createTeam } from '@core/team/actions';
import { generateDeviceKeys, KEY_BYTES, type DeviceKeys, type TeamCrypto } from '@core/team/crypto';
import type { InviteToken } from '@core/team/invite';
import type { TeamAlert } from '@core/teamui/alerts';
import { cleanName, nameText, SYS_PROFILE, systemMessage } from '@core/teamui/system';

import { addBreadcrumb } from '@lib/errorReporting';

import type { MeshTransport } from './meshTransport';
import { DEFAULT_TEAM_PREFS, type TeamDisk, type TeamRecord } from './teamDisk';
import { JoinAttempt } from './teamJoin';
import { TeamSession, type ActionError } from './teamSession';

export interface ServiceDeps {
  c: TeamCrypto;
  disk: TeamDisk;
  transport: MeshTransport | null;
  now?: () => number;
  /** Re-sync period of open sessions (ms); 0 when tests tick by hand. */
  tickMs?: number;
}

export type ServiceListener = () => void;
export type AlertListener = (alert: TeamAlert, teamId: string) => void;

/** After a join, report when no teammate link comes up within this long (the joiner flake). */
export const FIRST_LINK_WATCH_MS = 30_000;

export class TeamService {
  private keys: DeviceKeys | null = null;
  private records: TeamRecord[] = [];
  private session: TeamSession | null = null;
  private joining: JoinAttempt | null = null;
  private joinName = '';
  private readonly listeners = new Set<ServiceListener>();
  private readonly alertListeners = new Set<AlertListener>();
  private loaded: Promise<void> | null = null;
  readonly now: () => number;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
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

  private emit = (): void => {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A UI listener's failure must not break the sync plumbing.
      }
    }
  };

  // ── Identity and the team list ───────────────────────────────────────────

  /** Load the team list (the device keys load lazily, on first use). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      this.records = await this.deps.disk.loadTeams();
      this.emit();
    })();
    return this.loaded;
  }

  get teams(): readonly TeamRecord[] {
    return this.records;
  }

  /** The team to reopen at launch: the one opened last. */
  get lastOpened(): TeamRecord | null {
    let best: TeamRecord | null = null;
    for (const r of this.records) {
      if (best === null || (r.lastOpenedAt ?? r.joinedAt) > (best.lastOpenedAt ?? best.joinedAt))
        best = r;
    }
    return best;
  }

  get active(): TeamSession | null {
    return this.session;
  }

  get join(): JoinAttempt | null {
    return this.joining;
  }

  /** This device's keys, created on first team use and kept in the secure store. */
  private async deviceKeys(): Promise<DeviceKeys> {
    if (this.keys) return this.keys;
    const c = this.deps.c;
    const saved = await this.deps.disk.loadDevice();
    const sign = saved ? fromB64uLen(saved.sign, KEY_BYTES) : undefined;
    const box = saved ? fromB64uLen(saved.box, KEY_BYTES) : undefined;
    if (sign && box) {
      this.keys = {
        signSecret: sign,
        signPublic: c.ed25519.publicKey(sign),
        boxSecret: box,
        boxPublic: c.x25519.publicKey(box),
      };
      return this.keys;
    }
    const fresh = generateDeviceKeys(c);
    const ok = await this.deps.disk.saveDevice({
      v: 1,
      sign: toB64u(fresh.signSecret),
      box: toB64u(fresh.boxSecret),
    });
    // Without a key that survives a relaunch, every team would fork on restart.
    if (!ok) throw new Error('Could not save the team key in the secure store');
    this.keys = fresh;
    return fresh;
  }

  private saveRecords(): void {
    this.deps.disk.saveTeams(this.records);
  }

  private putRecord(record: TeamRecord): void {
    const i = this.records.findIndex((r) => r.teamId === record.teamId);
    if (i >= 0) this.records[i] = record;
    else this.records.push(record);
    this.records = [...this.records];
    this.saveRecords();
  }

  private sessionDeps() {
    return {
      c: this.deps.c,
      disk: this.deps.disk,
      transport: this.deps.transport,
      now: this.now,
      newId: () => toB64u(this.deps.c.randomBytes(9)),
      onChange: this.emit,
      onAlert: (alert: TeamAlert) => {
        const teamId = this.session?.teamId ?? '';
        for (const fn of [...this.alertListeners]) fn(alert, teamId);
      },
      ...(this.deps.tickMs !== undefined ? { tickMs: this.deps.tickMs } : {}),
    };
  }

  /** The network this phone is on (hotspot fallback hints); null without a mesh. */
  networkInfo(): ReturnType<MeshTransport['networkInfo']> | null {
    try {
      return this.deps.transport?.networkInfo() ?? null;
    } catch {
      return null;
    }
  }

  // ── Teams ────────────────────────────────────────────────────────────────

  /** Found a team; it becomes the active one (mesh not started: `startMesh`). */
  async createTeam(options: {
    name: string;
    myName: string;
    lifetimeMs: number;
  }): Promise<TeamSession> {
    await this.load();
    const name = cleanName(options.name);
    const myName = cleanName(options.myName);
    if (name === null || myName === null) throw new Error('A team and a display name are needed');
    const keys = await this.deviceKeys();
    const now = this.now();
    const team = createTeam(this.deps.c, keys, now, { name, lifetimeMs: options.lifetimeMs });
    // Genesis to disk before anything else (the chain starts here).
    this.deps.disk.appendOps(team.teamId, [team.genesis.env]);
    this.deps.disk.saveCursor(team.teamId, team.writer.cursor);
    const record: TeamRecord = {
      teamId: team.teamId,
      name,
      myName,
      joinedAt: now,
      prefs: { ...DEFAULT_TEAM_PREFS },
      lastReadAt: 0,
    };
    this.putRecord(record);
    const session = await this.activate(team.teamId);
    session.replica.addKey(team.key);
    session.setMyName(myName);
    session.republishIfNewKey();
    return session;
  }

  /** Open a team and make it the active one (stops the previous team's mesh). */
  async activate(teamId: string): Promise<TeamSession> {
    await this.load();
    if (this.session?.teamId === teamId) return this.session;
    const record = this.records.find((r) => r.teamId === teamId);
    if (record === undefined) throw new Error('Unknown team');
    await this.deactivate();
    const session = await TeamSession.open(this.sessionDeps(), record, await this.deviceKeys());
    session.onRecordChange = (r) => this.putRecord(r);
    this.session = session;
    session.updateRecord({ lastOpenedAt: this.now() });
    if (record.name !== session.view().name) session.updateRecord({ name: session.view().name });
    this.emit();
    return session;
  }

  async deactivate(): Promise<void> {
    const s = this.session;
    this.session = null;
    await s?.stopMesh();
    this.emit();
  }

  /**
   * Delete a team from this phone: tell the admins (they remove me and rotate
   * the key), stop its mesh, delete its log. What teammates already have stays
   * on their phones; nothing can be wiped remotely.
   */
  async leave(teamId: string): Promise<void> {
    await this.load();
    if (this.session?.teamId === teamId) {
      this.session.announceLeave();
      // Give the goodbye a moment to reach whoever is connected.
      this.session.tick();
      await this.deactivate();
    }
    this.deps.disk.deleteTeam(teamId);
    this.records = this.records.filter((r) => r.teamId !== teamId);
    this.saveRecords();
    this.emit();
  }

  // ── Joining ──────────────────────────────────────────────────────────────

  /** Start joining with an invite; the active team's mesh stops meanwhile. */
  async startJoin(token: InviteToken, myName: string): Promise<JoinAttempt> {
    await this.load();
    const name = cleanName(myName);
    if (name === null) throw new Error('A display name is needed');
    if (this.records.some((r) => r.teamId === token.teamId)) throw new Error('already-member');
    await this.cancelJoin();
    await this.deactivate();
    const attempt = new JoinAttempt(
      {
        c: this.deps.c,
        disk: this.deps.disk,
        transport: this.deps.transport,
        now: this.now,
        onChange: this.emit,
        ...(this.deps.tickMs !== undefined ? { tickMs: this.deps.tickMs } : {}),
      },
      token,
      await this.deviceKeys(),
    );
    this.joining = attempt;
    this.joinName = name;
    await attempt.start();
    this.emit();
    return attempt;
  }

  /** Abandon a join (codes didn't match, or the user gave up): its data is deleted. */
  async cancelJoin(): Promise<void> {
    const attempt = this.joining;
    if (attempt === null) return;
    this.joining = null;
    await attempt.stop();
    if (!this.records.some((r) => r.teamId === attempt.teamId)) {
      this.deps.disk.deleteTeam(attempt.teamId);
    }
    this.emit();
  }

  /** The codes matched: keep the team, post my name, make it active. */
  async confirmJoin(): Promise<TeamSession | ActionError> {
    const attempt = this.joining;
    if (attempt === null || !attempt.admitted) return 'not-member';
    // Write my name through the join's store (same log, same cursor on disk).
    attempt.store.track(() => ({
      result: attempt.replica.write(
        this.now(),
        'msg',
        systemMessage(toB64u(this.deps.c.randomBytes(9)), SYS_PROFILE, nameText(this.joinName)),
      ),
      accepted: [],
    }));
    this.joining = null;
    await attempt.stop();
    const now = this.now();
    this.putRecord({
      teamId: attempt.teamId,
      name: 'Team',
      myName: this.joinName,
      joinedAt: now,
      prefs: { ...DEFAULT_TEAM_PREFS },
      lastReadAt: 0,
      ...(attempt.replica.state.sendKeyId ? { profileKeyId: attempt.replica.state.sendKeyId } : {}),
    });
    const session = await this.activate(attempt.teamId);
    addBreadcrumb('team join: confirmed, team session opened');
    session.watchFirstLinkMs = FIRST_LINK_WATCH_MS;
    this.emit();
    return session;
  }
}
