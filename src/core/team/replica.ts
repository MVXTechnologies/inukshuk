import { fromB64uLen } from './bytes';
import { isRecord, type Json } from './canonical';
import { KEY_BYTES, type DeviceKeys, type TeamCrypto } from './crypto';
import { admitBody, OpWriter } from './actions';
import { reduceData, type TeamData } from './data';
import {
  checkEnvelope,
  isControlType,
  openPayload,
  type Encryption,
  type RejectReason,
  type SignedOp,
} from './envelope';
import { hlcObserve, type Hlc } from './hlc';
import { deriveTeamId, memberIdOf, memberPublicKey } from './ids';
import { verifyJoinProof, type JoinProof } from './invite';
import { parseKeyWraps, unwrapKeys, type TeamKey } from './keys';
import { OpLog, type VersionVector } from './log';
import { isAdminRole, type Audience, type Priority } from './roles';
import { resolveTeam, type TeamState } from './membership';

/**
 * One device's copy of one team (#589): the op log, the resolved membership,
 * the keyring and the device's own writer. Pure and in-memory; the data layer
 * persists `log` records, the writer cursor and the keyring (secure store)
 * and rebuilds a replica from them on launch.
 *
 * Every peer-facing method is total: hostile input yields a report, never an
 * exception.
 */
export type IngestRejection = RejectReason | 'removed' | 'quarantine-full' | 'stale';

export interface IngestReport {
  /** Ops newly stored (logged or ephemeral). */
  accepted: SignedOp[];
  rejected: { reason: IngestRejection; id?: string }[];
  duplicates: number;
  /** `[kept, conflicting]` op ids from a member who signed two histories. */
  equivocations: [string, string][];
  /** Validly signed ops from authors we don't know yet, held until their admission arrives. */
  quarantined: number;
}

/** Bounds on ops from not-yet-known authors (they cost storage before anyone vouches for them). */
export const MAX_QUARANTINE_OPS = 512;
export const MAX_QUARANTINE_BYTES = 1024 * 1024;

export class TeamReplica {
  readonly log = new OpLog();
  readonly writer: OpWriter;
  readonly id: string;
  private readonly quarantine = new Map<string, SignedOp>();
  private quarantineBytes = 0;
  private readonly keyring = new Map<string, Uint8Array>();
  private readonly unwrapped = new Set<string>();
  private readonly decoded = new Map<string, Json>();
  private readonly proofCache = new Map<string, boolean>();
  private dataCache: TeamData | undefined;
  state: TeamState;

  constructor(
    private readonly c: TeamCrypto,
    readonly teamId: string,
    readonly keys: DeviceKeys,
    cursor?: { seq: number; hlc: Hlc },
  ) {
    this.writer = new OpWriter(c, keys, teamId, cursor?.seq ?? 0, cursor?.hlc);
    this.id = memberIdOf(keys.signPublic);
    this.state = resolveTeam(c, teamId, []);
  }

  /** Import keys from the secure store (or the creator's first key). */
  addKey(key: TeamKey): void {
    this.keyring.set(key.keyId, key.key);
    this.dataCache = undefined;
  }

  key(keyId: string): Uint8Array | undefined {
    return this.keyring.get(keyId);
  }

  /** The key new group-mode ops must use, or `undefined` while a rotation is pending. */
  sendKey(): TeamKey | undefined {
    const keyId = this.state.sendKeyId;
    const key = keyId === undefined ? undefined : this.keyring.get(keyId);
    return keyId !== undefined && key !== undefined ? { keyId, key } : undefined;
  }

  isActiveMember(memberId: string): boolean {
    return this.state.members.get(memberId)?.status === 'active';
  }

  versionVector(): VersionVector {
    return this.log.versionVector();
  }

  opsInRange(author: string, from: number, to: number): SignedOp[] {
    return this.log.range(author, from, to);
  }

  liveEphemeral(now: number): SignedOp[] {
    return this.log.liveEphemeral(now);
  }

  /** Is this a genesis op for *our* team id (cheap pre-check before storing it)? */
  private isOurGenesis(op: SignedOp): boolean {
    const b = op.env.b;
    const pub = memberPublicKey(op.env.au);
    const nonce = isRecord(b) ? fromB64uLen(b['nonce'], 16) : undefined;
    return (
      pub !== undefined && nonce !== undefined && deriveTeamId(this.c, pub, nonce) === this.teamId
    );
  }

  /** Admit a batch of untrusted envelopes. Total. */
  ingest(raws: readonly unknown[], now: number): IngestReport {
    const report: IngestReport = {
      accepted: [],
      rejected: [],
      duplicates: 0,
      equivocations: [],
      quarantined: 0,
    };
    let changed = false;
    // Ops whose author is admitted earlier in this same batch: retried after a recompute.
    const pending: SignedOp[] = [];
    for (const raw of raws) {
      const check = checkEnvelope(this.c, raw, { teamId: this.teamId, now });
      if (!check.ok) {
        report.rejected.push({ reason: check.reason });
        continue;
      }
      const op = check.op;
      const member = this.state.members.get(op.env.au);
      if (member?.removeCut !== undefined && op.env.sq > member.removeCut) {
        report.rejected.push({ reason: 'removed', id: op.id });
        continue;
      }
      const known = member !== undefined || (op.env.t === 'm.genesis' && this.isOurGenesis(op));
      if (known) changed = this.store(op, now, report) || changed;
      else pending.push(op);
    }
    // Storing ops can admit authors (an admit in this batch, or in the quarantine): iterate.
    for (let round = 0; round < 8 && changed; round++) {
      this.recompute(now);
      changed = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const op = pending[i]!;
        if (!this.state.members.has(op.env.au)) continue;
        pending.splice(i, 1);
        changed = this.store(op, now, report) || changed;
      }
      for (const [id, op] of this.quarantine) {
        if (!this.state.members.has(op.env.au)) continue;
        this.quarantine.delete(id);
        this.quarantineBytes -= op.bytes;
        changed = this.store(op, now, report) || changed;
      }
    }
    for (const op of pending) this.hold(op, report);
    return report;
  }

  /** Park a validly signed op from an author we don't know yet (bounded). */
  private hold(op: SignedOp, report: IngestReport): void {
    if (this.quarantine.has(op.id) || this.log.has(op.id)) {
      report.duplicates++;
    } else if (
      this.quarantine.size >= MAX_QUARANTINE_OPS ||
      this.quarantineBytes + op.bytes > MAX_QUARANTINE_BYTES
    ) {
      report.rejected.push({ reason: 'quarantine-full', id: op.id });
    } else {
      this.quarantine.set(op.id, op);
      this.quarantineBytes += op.bytes;
      report.quarantined++;
    }
  }

  private store(op: SignedOp, now: number, report: IngestReport): boolean {
    const result = this.log.insert(op, now);
    if (result === 'new') {
      report.accepted.push(op);
      this.writer.observe(hlcObserve(this.writer.cursor.hlc, op.stamp, now));
      return true;
    }
    if (result === 'duplicate') report.duplicates++;
    else if (result === 'stale') report.rejected.push({ reason: 'stale', id: op.id });
    else report.equivocations.push(this.log.equivocations[this.log.equivocations.length - 1]!);
    return false;
  }

  private recompute(now: number): void {
    this.state = resolveTeam(
      this.c,
      this.teamId,
      [...this.log.logged(), ...this.log.liveEphemeral(now)],
      { proofCache: this.proofCache },
    );
    this.dataCache = undefined;
    for (const m of this.state.members.values()) {
      if (m.removeCut !== undefined) this.log.dropAbove(m.id, m.removeCut);
    }
    const me = { id: this.id, boxSecret: this.keys.boxSecret };
    for (const op of this.state.control) {
      if (this.unwrapped.has(op.id)) continue;
      this.unwrapped.add(op.id);
      const kw = isRecord(op.env.b) ? parseKeyWraps(op.env.b['kw']) : undefined;
      if (kw === undefined || !kw.w.some(([m]) => m === this.id)) continue;
      for (const k of unwrapKeys(this.c, this.teamId, kw, me)) this.keyring.set(k.keyId, k.key);
    }
  }

  /** Decrypt an op's body (cached on success). */
  decode(op: SignedOp): Json | undefined {
    const hit = this.decoded.get(op.id);
    if (hit !== undefined) return hit;
    const body = isControlType(op.env.t)
      ? undefined
      : openPayload(this.c, op.env, (k) => this.keyring.get(k), {
          id: this.id,
          boxSecret: this.keys.boxSecret,
        });
    if (body !== undefined) this.decoded.set(op.id, body);
    return body;
  }

  /** Decrypt a control op's labels (names). */
  labels(op: SignedOp): Json | undefined {
    return openPayload(this.c, op.env, (k) => this.keyring.get(k));
  }

  data(): TeamData {
    this.dataCache ??= reduceData(this.state, (op) => this.decode(op));
    return this.dataCache;
  }

  // ── Local authoring ───────────────────────────────────────────────────────

  /** Store an op this device just built (it goes through the same checks as a peer's). */
  commit(op: SignedOp, now: number): IngestReport {
    return this.ingest([op.env], now);
  }

  control(now: number, t: Parameters<OpWriter['control']>[1], b: Json, secret?: Json): SignedOp {
    const key = this.sendKey();
    const op = this.writer.control(
      now,
      t,
      b,
      secret !== undefined && key ? { secret, key } : undefined,
    );
    this.commit(op, now);
    return op;
  }

  /**
   * Write a data op. `sealedTo` seals it to those members (plus me) instead of
   * the team key. Returns `undefined` when no usable key exists (a rotation is
   * pending: fail closed) or a sealed recipient is unknown.
   */
  write(
    now: number,
    t: 'e.set' | 'e.del' | 'msg',
    secret: Json,
    options: { aud?: Audience; pr?: Priority; sealedTo?: readonly string[] } = {},
  ): SignedOp | undefined {
    const enc = this.encryptionFor(options.sealedTo);
    if (enc === undefined) return undefined;
    const extra: { aud?: Audience; pr?: Priority } = {};
    if (options.aud) extra.aud = options.aud;
    if (options.pr) extra.pr = options.pr;
    const op = this.writer.data(now, t, secret, enc, extra);
    this.commit(op, now);
    return op;
  }

  /** Share my position (ephemeral, `ttlS` seconds). */
  position(
    now: number,
    pos: Json,
    ttlS = 6 * 3600,
    sealedTo?: readonly string[],
  ): SignedOp | undefined {
    const enc = this.encryptionFor(sealedTo);
    if (enc === undefined) return undefined;
    const op = this.writer.ephemeral(now, { t: 'pos', secret: pos, enc, ttl: ttlS });
    this.commit(op, now);
    return op;
  }

  private encryptionFor(sealedTo: readonly string[] | undefined): Encryption | undefined {
    if (sealedTo === undefined) {
      const key = this.sendKey();
      return key ? { mode: 'group', keyId: key.keyId, key: key.key } : undefined;
    }
    const ids = [...new Set([...sealedTo, this.id])];
    const recipients: { id: string; boxPublic: Uint8Array }[] = [];
    for (const id of ids) {
      const m = this.state.members.get(id);
      const box = m?.status === 'active' ? fromB64uLen(m.x, KEY_BYTES) : undefined;
      if (box === undefined) return undefined;
      recipients.push({ id, boxPublic: box });
    }
    return { mode: 'sealed', recipients };
  }

  /**
   * A joiner presented a join proof on the LAN: check it against our log and
   * our wall clock, then record `m.admit`. Returns the op, or why not.
   */
  admit(proof: JoinProof, now: number): { op: SignedOp } | { error: string } {
    const self = this.state.members.get(this.id);
    if (self?.status !== 'active' || self.role === 'guest') return { error: 'not-allowed' };
    const inv = this.state.invites.get(proof.inv);
    if (inv === undefined) return { error: 'unknown-invite' };
    if (inv.revoked) return { error: 'revoked' };
    if (now > inv.expiresAt) return { error: 'expired' };
    if (inv.uses >= inv.maxUses) return { error: 'used' };
    if (inv.approve === 'admin' && !isAdminRole(self.role)) return { error: 'needs-admin' };
    if (this.state.members.has(proof.m)) return { error: 'exists' };
    if (!verifyJoinProof(this.c, this.teamId, proof)) return { error: 'bad-proof' };
    const key = this.sendKey();
    if (key === undefined) return { error: 'rotation-pending' };
    const op = this.writer.control(now, 'm.admit', admitBody(this.c, this.teamId, proof, key));
    const report = this.commit(op, now);
    if (this.state.rejected.has(op.id)) return { error: this.state.rejected.get(op.id)! };
    return report.accepted.length > 0 ? { op } : { error: 'not-stored' };
  }

  /** For tests and diagnostics. */
  get quarantineSize(): number {
    return this.quarantine.size;
  }
}
