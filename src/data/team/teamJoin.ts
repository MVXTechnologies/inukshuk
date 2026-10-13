/**
 * Joining a team with an invite (#589, spec §8.2), from this phone's side:
 *
 * 1. browse the LAN / hotspot for the team's discovery tag (never advertise:
 *    we are not a member yet), and dial the QR's address hint if it has one,
 *    or a typed address (the hotspot fallback);
 * 2. open a session with the join proof; any member in range admits us and
 *    sends the log;
 * 3. the session's six-digit safety code is shown on both phones to compare
 *    out loud;
 * 4. once the log shows us as an active member, the user confirms the codes
 *    and the service turns this into an ordinary team session.
 *
 * The replica writes through to disk from the first op (`PersistingStore`),
 * so an interrupted join that already got us admitted is not lost; a join
 * the user cancels deletes it.
 */
import { lanDiscoveryTag } from '@core/mesh/tag';
import { addBreadcrumb } from '@lib/errorReporting';
import type { DeviceKeys, TeamCrypto } from '@core/team/crypto';
import { makeJoinProof, type InviteToken } from '@core/team/invite';
import { TeamReplica } from '@core/team/replica';
import { SyncSession, type SessionEvent } from '@core/team/sync';

import { MeshLink, type MeshLinkStatus } from './meshLink';
import { MeshSessionHost } from './meshSessions';
import type { MeshTransport } from './meshTransport';
import { PersistingStore } from './persistingStore';
import { teamDebug } from './teamDebug';
import type { TeamDisk } from './teamDisk';

export type JoinPhase =
  /** Looking for a teammate's phone on this network. */
  | 'searching'
  /** Connected; handshake and admission under way. */
  | 'connecting'
  /** Admitted: compare the safety code, then confirm. */
  | 'verify'
  | 'failed';

export type JoinFailure =
  'expired' | 'no-mesh' | 'refused' | 'used' | 'not-found' | 'local-network-denied';

export interface JoinState {
  teamId: string;
  phase: JoinPhase;
  /** The six digits to compare with the admitting phone. */
  safetyCode: string | null;
  failure: JoinFailure | null;
  /** The hint's address, when the QR carried one. */
  hint: { host: string; port: number } | null;
  mesh: MeshLinkStatus | null;
  /** Typed addresses being retried. */
  dials: string[];
  startedAt: number;
}

/** After this long with no teammate found, suggest the hotspot fallback. */
export const JOIN_SEARCH_HINT_MS = 15_000;

export class JoinAttempt {
  readonly replica: TeamReplica;
  readonly store: PersistingStore;
  private link: MeshLink | null = null;
  private host: MeshSessionHost<SessionEvent, SyncSession> | null = null;
  private phase: JoinPhase = 'searching';
  private failure: JoinFailure | null = null;
  private safetyCode: string | null = null;
  private readonly startedAt: number;
  private readonly hint: { host: string; port: number } | null;

  constructor(
    private readonly deps: {
      c: TeamCrypto;
      disk: TeamDisk;
      transport: MeshTransport | null;
      now: () => number;
      onChange: () => void;
      tickMs?: number;
    },
    readonly token: InviteToken,
    keys: DeviceKeys,
  ) {
    this.replica = new TeamReplica(deps.c, token.teamId, keys);
    this.store = new PersistingStore(this.replica, deps.disk);
    this.store.onStored = () => this.check();
    this.startedAt = deps.now();
    this.hint = token.net ? { host: token.net.host.join('.'), port: token.net.port } : null;
  }

  get teamId(): string {
    return this.token.teamId;
  }

  /** Admitted: the log we hold names us an active member. */
  get admitted(): boolean {
    return this.replica.isActiveMember(this.replica.id);
  }

  state(): JoinState {
    return {
      teamId: this.teamId,
      phase: this.phase,
      safetyCode: this.safetyCode,
      failure: this.failure,
      hint: this.hint,
      mesh: this.link?.status() ?? null,
      dials: this.link?.manualDials ?? [],
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    const transport = this.deps.transport;
    if (transport === null) return this.fail('no-mesh');
    if (this.token.expiresAt < this.deps.now()) return this.fail('expired');
    const proof = makeJoinProof(this.deps.c, this.token, this.replica.keys);
    this.host = new MeshSessionHost<SessionEvent, SyncSession>(
      transport,
      {
        initiate: () =>
          SyncSession.initiate(this.deps.c, this.store, { join: proof, now: this.deps.now() }),
        // Not a member yet: an inbound session cannot complete (the core refuses it).
        respond: () => SyncSession.respond(this.deps.c, this.store),
      },
      (_peerId, event, session) => this.onEvent(event, session),
      { now: this.deps.now, tickMs: this.deps.tickMs ?? 5_000, label: 'join' },
    );
    this.host.start();
    this.link = new MeshLink(transport, {
      tag: lanDiscoveryTag(this.teamId, (d) => this.deps.c.sha256(d)),
      advertise: false,
      oneAtATime: true,
      onChange: () => this.onMesh(),
    });
    await this.link.start();
    teamDebug('join', 'start', this.teamId, this.hint ? `hint ${this.hint.host}` : 'no hint');
    if (this.hint) this.link.dial(this.hint.host, this.hint.port);
    this.deps.onChange();
  }

  /** The hotspot fallback: dial a typed address (or a hotspot candidate). */
  dial(host: string, port: number): void {
    this.link?.dial(host, port);
    this.deps.onChange();
  }

  /** Stop the mesh used by the join (the team session starts its own). */
  async stop(): Promise<void> {
    const link = this.link;
    const host = this.host;
    this.link = null;
    this.host = null;
    host?.stop('bye');
    await link?.stop();
  }

  private fail(why: JoinFailure): void {
    addBreadcrumb(`team join: failed (${why})`);
    teamDebug('join', 'failed', why);
    this.phase = 'failed';
    this.failure = why;
    this.deps.onChange();
  }

  private onMesh(): void {
    const status = this.link?.status();
    if (status?.localNetwork === 'denied' && this.phase === 'searching') {
      this.fail('local-network-denied');
      return;
    }
    if (this.phase === 'searching' && this.host !== null && this.host.size > 0) {
      this.phase = 'connecting';
      teamDebug('join', 'phase connecting');
    }
    teamDebug('join', 'mesh', JSON.stringify(status ?? null));
    this.deps.onChange();
  }

  private onEvent(event: SessionEvent, session: SyncSession): void {
    switch (event.type) {
      case 'open':
        this.safetyCode = session.safetyCode ?? null;
        if (this.phase !== 'verify') this.phase = 'connecting';
        this.check();
        return;
      case 'closed':
        if (this.phase !== 'verify' && !this.admitted && !this.othersAlive(session)) {
          // The admitting side explains why in the close reason.
          const why = event.why;
          if (/used|exists/.test(why)) this.fail('used');
          else if (/expired/.test(why)) this.fail('expired');
          else if (/revoked|bad-proof|unknown-invite|not-allowed|needs-admin/.test(why)) {
            this.fail('refused');
          } else if (this.host?.size === 0) this.phase = 'searching';
        }
        this.deps.onChange();
        return;
      default:
        this.check();
        return;
    }
  }

  /** Another connection is still trying (one refusal is not the last word). */
  private othersAlive(closed: SyncSession): boolean {
    return (this.host?.peers() ?? []).some(
      (p) => p.session !== closed && p.session.phase !== 'closed',
    );
  }

  private check(): void {
    if (this.phase !== 'verify' && this.phase !== 'failed' && this.admitted) {
      this.phase = 'verify';
      addBreadcrumb('team join: admitted');
      teamDebug('join', 'admitted');
    }
    this.deps.onChange();
  }
}
