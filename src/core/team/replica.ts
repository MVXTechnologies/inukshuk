import { fromB64uLen } from './bytes';
import { isRecord, type Json } from './canonical';
import { KEY_BYTES, type DeviceKeys, type TeamCrypto } from './crypto';
import { admitBody, OpWriter, rotateBody, type WriterCursor } from './actions';
import { applyDataOp, emptyData, type TeamData } from './data';
import {
  checkEnvelope,
  expiresAt,
  isControlType,
  isEphemeralType,
  openPayload,
  type Encryption,
  type RejectReason,
  type SignedOp,
} from './envelope';
import { deriveTeamId, memberIdOf, memberPublicKey } from './ids';
import { verifyJoinProof, type JoinProof } from './invite';
import { parseKeyWraps, unwrapKeys, type TeamKey } from './keys';
import { OpLog, type VersionVector } from './log';
import {
  activeMembers,
  admitEphemeral,
  appendOps,
  canAppend,
  compareOps,
  resolveFolder,
  type Folder,
  type TeamState,
} from './membership';
import { isAdminRole, type Audience, type Priority } from './roles';

/**
 * One device's copy of one team (#589): the op log, the resolved membership,
 * the keyring and the device's own writer. Pure and in-memory; the data layer
 * persists `log` records, the writer cursor and the keyring (secure store)
 * and rebuilds a replica from them on launch.
 *
 * **Cost model (review M2).** A batch of ops that only *appends* (each op sorts
 * after the fold head and extends its author's chain) is applied
 * incrementally: per-op fold step and, if the data view exists, per-op data
 * merge. Anything else (old ops arriving, forks, removals, role changes)
 * refolds once per batch. Positions never touch the fold: they are checked
 * against the current state when the data view is read.
 *
 * Every peer-facing method is total: hostile input yields a report, never an
 * exception.
 */
export type IngestRejection =
  RejectReason | 'removed' | 'quarantine-full' | 'gap-full' | 'stale' | 'full';

export interface IngestReport {
  /** Ops newly stored (logged or ephemeral). */
  accepted: SignedOp[];
  rejected: { reason: IngestRejection; id?: string }[];
  duplicates: number;
  /** `[first, conflicting]` op ids from an author who signed two histories; both are kept. */
  equivocations: [string, string][];
  /** Validly signed ops from authors we don't know yet, held until their admission arrives. */
  quarantined: number;
  /** Ops waiting for a missing predecessor (gap buffer). */
  parked: number;
}

/** Bounds on ops from not-yet-known authors (they cost storage before anyone vouches for them). */
export const MAX_QUARANTINE_OPS = 512;
export const MAX_QUARANTINE_BYTES = 1024 * 1024;
export const MAX_QUARANTINE_PER_AUTHOR = 64;
/**
 * After an author's first proven equivocation, their further forks are only
 * stored (evidence) and folded by a coalesced refold at most this often
 * (re-review #3): a forking member cannot make every peer refold per op.
 */
export const FORK_REFOLD_INTERVAL_MS = 10_000;
/** Data-only rebuilds (old ops arriving) run at most this often; reads flush them. */
export const MIN_REFOLD_GAP_MS = 1_000;
/** Ops whose predecessor (`pv`) we don't hold wait here, unfolded (re-review #2). */
export const MAX_GAP_OPS = 4096;
export const MAX_GAP_PER_AUTHOR = 256;
/** An admin replica auto-rotates for a given leaking author at most this often. */
export const AUTO_ROTATE_INTERVAL_MS = 30 * 60 * 1000;

export class TeamReplica {
  readonly log = new OpLog();
  readonly writer: OpWriter;
  readonly id: string;
  /** Insertion-ordered: the oldest entry is evicted first. */
  private readonly quarantine = new Map<string, SignedOp>();
  private quarantineBytes = 0;
  private readonly keyring = new Map<string, Uint8Array>();
  private readonly unwrapped = new Set<string>();
  private readonly decoded = new Map<string, Json>();
  private readonly proofCache = new Map<string, boolean>();
  private folder: Folder | undefined;
  /** Authors with a proven equivocation (their later forks are deferred). */
  private readonly equivocators = new Set<string>();
  private deferredForks = false;
  private lastFullFold = -Infinity;
  /** Diagnostics: how many full refolds this replica has run. */
  fullFolds = 0;
  /** Logged ops stored but not folded yet (a coalesced rebuild is pending). */
  private dataDirty = false;
  /** Per author, the chain we hold (for the version vector and serving). */
  private held = new Map<string, string[]>();
  /** Gap buffer: by op id (insertion order = eviction order) and by awaited predecessor. */
  private readonly gap = new Map<string, SignedOp>();
  private readonly gapByPrev = new Map<string, SignedOp[]>();
  private readonly gapPerAuthor = new Map<string, number>();
  /** Admin policy: rotate for leaks automatically, at most once per author per interval. */
  autoRotate = true;
  private readonly autoRotated = new Map<string, number>();
  private rotating = false;
  private entityCache: TeamData | undefined;
  /** Positions view; dropped on a new position, a refold or the first expiry. */
  private positionCache:
    { state: TeamState; validUntil: number; view: TeamData['positions'] } | undefined;
  private now = 0;
  state: TeamState;

  constructor(
    private readonly c: TeamCrypto,
    readonly teamId: string,
    readonly keys: DeviceKeys,
    cursor?: WriterCursor,
  ) {
    this.writer = new OpWriter(c, keys, teamId, cursor?.seq ?? 0, cursor?.hlc, cursor?.prev);
    this.id = memberIdOf(keys.signPublic);
    this.state = resolveFolder(c, teamId, []).state;
  }

  /** Import keys from the secure store (or the creator's first key). */
  addKey(key: TeamKey): void {
    this.keyring.set(key.keyId, key.key);
    this.entityCache = undefined;
    this.positionCache = undefined;
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

  /** Per author, the length of the canonical chain held (`chain.ts`). */
  versionVector(): VersionVector {
    const out: VersionVector = Object.create(null) as VersionVector;
    for (const a of [...this.held.keys()].sort()) {
      const n = this.held.get(a)!.length;
      if (n > 0) out[a] = n;
    }
    // Ops held before the genesis resolves still count, so a joiner can relay.
    return out;
  }

  /** Canonical ops `from..to` of one author. */
  opsInRange(author: string, from: number, to: number): SignedOp[] {
    const ids = this.held.get(author) ?? [];
    return ids.slice(Math.max(0, from - 1), Math.max(0, to)).map((id) => this.log.get(id)!);
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
    this.now = Math.max(this.now, now);
    const report: IngestReport = {
      accepted: [],
      rejected: [],
      duplicates: 0,
      equivocations: [],
      quarantined: 0,
      parked: 0,
    };
    const fresh: SignedOp[] = [];
    /** Ops that must fold now: membership changes and chain-repairing (pinned) ops. */
    const urgent = new Set<string>();
    // Ops whose author is admitted earlier in this same batch: retried after the fold.
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
      if (known) this.store(op, now, report, fresh, urgent);
      else pending.push(op);
    }
    // Folding can admit authors (an admit in this batch, or in the quarantine): iterate.
    for (let round = 0; round < 8 && fresh.length > 0; round++) {
      this.refold(fresh.splice(0), now, urgent);
      const ready: SignedOp[] = [];
      for (let i = pending.length - 1; i >= 0; i--) {
        if (this.state.members.has(pending[i]!.env.au)) ready.push(pending.splice(i, 1)[0]!);
      }
      for (const [id, op] of this.quarantine) {
        if (!this.state.members.has(op.env.au)) continue;
        this.quarantine.delete(id);
        this.quarantineBytes -= op.bytes;
        ready.push(op);
      }
      // In chain order, so predecessors are stored before the ops naming them.
      ready.sort((x, y) => x.env.sq - y.env.sq || compareOps(x, y));
      for (const op of ready) this.store(op, now, report, fresh, urgent);
    }
    for (const op of pending) this.hold(op, report);
    this.flushIfDue(now);
    this.maybeAutoRotate(now);
    return report;
  }

  /**
   * Fold everything stored but not yet folded (deferred data or forks). Call
   * from the app's periodic tick (`SyncSession.tick(now)` does), so an idle
   * replica converges.
   */
  flush(now: number): void {
    if (this.dataDirty || this.deferredForks) this.refold([], now, undefined, true);
  }

  private flushIfDue(now: number): void {
    const since = now - this.lastFullFold;
    if (
      (this.dataDirty && since >= MIN_REFOLD_GAP_MS) ||
      (this.deferredForks && since >= FORK_REFOLD_INTERVAL_MS)
    ) {
      this.refold([], now, undefined, true);
    }
  }

  /**
   * Admin replicas rotate when a verified admission leaked the current key
   * (advisory, see `membership.ts`), at most once per leaking author per
   * {@link AUTO_ROTATE_INTERVAL_MS}, so no member can drive a rotation storm.
   */
  private maybeAutoRotate(now: number): void {
    if (!this.autoRotate || this.rotating || !this.state.rotationAdvised) return;
    const self = this.state.members.get(this.id);
    if (self?.status !== 'active' || !isAdminRole(self.role) || this.sendKey() === undefined) {
      return;
    }
    const newest = this.state.keyOrder[this.state.keyOrder.length - 1];
    const due = this.state.leaks.filter(
      (l) =>
        l.keyId === newest &&
        now - (this.autoRotated.get(l.author) ?? -Infinity) >= AUTO_ROTATE_INTERVAL_MS,
    );
    if (due.length === 0) return;
    for (const l of due) this.autoRotated.set(l.author, now);
    this.rotating = true;
    try {
      this.control(
        now,
        'k.rotate',
        rotateBody(this.c, this.teamId, activeMembers(this.state)).body,
      );
    } finally {
      this.rotating = false;
    }
  }

  /** Park a validly signed op from an author we don't know yet (bounded, oldest evicted). */
  private hold(op: SignedOp, report: IngestReport): void {
    if (this.quarantine.has(op.id) || this.log.has(op.id)) {
      report.duplicates++;
      return;
    }
    const mine = [...this.quarantine.values()].filter((q) => q.env.au === op.env.au).length;
    if (mine >= MAX_QUARANTINE_PER_AUTHOR || op.bytes > MAX_QUARANTINE_BYTES) {
      report.rejected.push({ reason: 'quarantine-full', id: op.id });
      return;
    }
    while (
      this.quarantine.size > 0 &&
      (this.quarantine.size >= MAX_QUARANTINE_OPS ||
        this.quarantineBytes + op.bytes > MAX_QUARANTINE_BYTES)
    ) {
      const [oldId, old] = this.quarantine.entries().next().value as [string, SignedOp];
      this.quarantine.delete(oldId);
      this.quarantineBytes -= old.bytes;
    }
    this.quarantine.set(op.id, op);
    this.quarantineBytes += op.bytes;
    report.quarantined++;
  }

  private store(
    op: SignedOp,
    now: number,
    report: IngestReport,
    fresh: SignedOp[],
    urgent: Set<string>,
  ): void {
    const pinned = this.state.chains.get(op.env.au)?.pinned.get(op.env.sq);
    const logged = !isEphemeralType(op.env.t);
    // A dangling predecessor: park it, unfolded, until the gap fills (re-review #2).
    if (
      logged &&
      op.env.pv !== undefined &&
      this.log.get(op.env.pv) === undefined &&
      op.id !== pinned
    ) {
      this.park(op, report);
      return;
    }
    const result = this.log.insert(op, now, pinned);
    if (result === 'duplicate') {
      report.duplicates++;
      return;
    }
    if (result === 'stale' || result === 'full') {
      report.rejected.push({ reason: result, id: op.id });
      return;
    }
    if (result === 'fork') {
      report.equivocations.push(this.log.equivocations[this.log.equivocations.length - 1]!);
      if (this.equivocators.has(op.env.au) && op.id !== pinned) {
        // Already proven: keep as evidence, fold later in one coalesced refold.
        report.accepted.push(op);
        this.deferredForks = true;
        this.promote(op, now, report, fresh, urgent);
        return;
      }
      this.equivocators.add(op.env.au);
    }
    report.accepted.push(op);
    if (!logged) {
      this.positionCache = undefined;
      return;
    }
    fresh.push(op);
    if (op.id === pinned || isControlType(op.env.t)) urgent.add(op.id);
    const ids = this.held.get(op.env.au) ?? [];
    if (op.env.sq === ids.length + 1 && op.env.pv === ids[ids.length - 1]) {
      ids.push(op.id);
      this.held.set(op.env.au, ids);
    }
    this.promote(op, now, report, fresh, urgent);
  }

  /** Store parked ops that were waiting for `op`. */
  private promote(
    op: SignedOp,
    now: number,
    report: IngestReport,
    fresh: SignedOp[],
    urgent: Set<string>,
  ): void {
    const waiting = this.gapByPrev.get(op.id);
    if (waiting === undefined) return;
    this.gapByPrev.delete(op.id);
    for (const next of waiting) {
      if (!this.gap.delete(next.id)) continue;
      this.gapPerAuthor.set(next.env.au, (this.gapPerAuthor.get(next.env.au) ?? 1) - 1);
      this.store(next, now, report, fresh, urgent);
    }
  }

  /** Bounded gap buffer: per-author cap, oldest evicted first. */
  private park(op: SignedOp, report: IngestReport): void {
    if (this.gap.has(op.id)) {
      report.duplicates++;
      return;
    }
    const mine = this.gapPerAuthor.get(op.env.au) ?? 0;
    if (mine >= MAX_GAP_PER_AUTHOR) {
      report.rejected.push({ reason: 'gap-full', id: op.id });
      return;
    }
    while (this.gap.size >= MAX_GAP_OPS) {
      const [oldId, old] = this.gap.entries().next().value as [string, SignedOp];
      this.unpark(oldId, old);
    }
    this.gap.set(op.id, op);
    this.gapPerAuthor.set(op.env.au, mine + 1);
    const list = this.gapByPrev.get(op.env.pv!) ?? [];
    list.push(op);
    this.gapByPrev.set(op.env.pv!, list);
    report.parked++;
  }

  private unpark(id: string, op: SignedOp): void {
    this.gap.delete(id);
    this.gapPerAuthor.set(op.env.au, (this.gapPerAuthor.get(op.env.au) ?? 1) - 1);
    const list = (this.gapByPrev.get(op.env.pv!) ?? []).filter((o) => o.id !== id);
    if (list.length > 0) this.gapByPrev.set(op.env.pv!, list);
    else this.gapByPrev.delete(op.env.pv!);
  }

  /** For tests and diagnostics. */
  get parkedSize(): number {
    return this.gap.size;
  }

  /** Fold new logged ops: append incrementally when possible, else refold once. */
  private refold(ops: SignedOp[], now: number, urgent?: Set<string>, force = false): void {
    const sorted = ops.sort(compareOps);
    let incremental = !force && !this.dataDirty && this.folder !== undefined;
    if (incremental) {
      // Check the whole batch extends the fold before taking the fast path.
      const grown = new Map<string, string[]>();
      let head = this.state.head;
      for (const op of sorted) {
        const ids = grown.get(op.env.au) ?? [...(this.state.chains.get(op.env.au)?.ids ?? [])];
        if (!canAppend(this.state, op, head, ids)) {
          incremental = false;
          break;
        }
        ids.push(op.id);
        grown.set(op.env.au, ids);
        head = op;
      }
    }
    if (incremental) {
      appendOps(this.folder!, sorted);
      this.state = this.folder!.state;
      if (this.entityCache) {
        for (const op of sorted) {
          // roleAt holds exactly the data ops the fold accepted.
          if (this.state.roleAt.has(op.id)) {
            applyDataOp(this.entityCache, this.state, op, (o) => this.decode(o));
          }
        }
      }
    } else if (
      !force &&
      !sorted.some((op) => urgent?.has(op.id)) &&
      now - this.lastFullFold < MIN_REFOLD_GAP_MS
    ) {
      // Data-only, out of order, and we rebuilt very recently: coalesce (re-review #3).
      this.dataDirty = true;
      return;
    } else {
      const { state, folder } = resolveFolder(this.c, this.teamId, this.log.logged(), {
        proofCache: this.proofCache,
      });
      this.state = state;
      this.folder = folder;
      this.deferredForks = false;
      this.dataDirty = false;
      this.lastFullFold = now;
      this.fullFolds++;
      this.held = new Map([...state.chains].map(([a, ch]) => [a, [...ch.ids]]));
      this.entityCache = undefined;
      this.positionCache = undefined;
      for (const m of state.members.values()) {
        if (m.removeCut !== undefined) this.log.dropAbove(m.id, m.removeCut);
      }
    }
    // Only accepted ops move our clock, and never far past our own (review M1).
    for (const op of sorted) {
      if (!this.state.rejected.has(op.id)) this.writer.observe(op.stamp, now);
    }
    this.unwrapNewKeys();
  }

  private unwrapNewKeys(): void {
    const me = { id: this.id, boxSecret: this.keys.boxSecret };
    for (const op of this.state.control) {
      if (this.unwrapped.has(op.id)) continue;
      this.unwrapped.add(op.id);
      const kw = isRecord(op.env.b) ? parseKeyWraps(op.env.b['kw']) : undefined;
      if (kw === undefined || !kw.w.some(([m]) => m === this.id)) continue;
      for (const k of unwrapKeys(this.c, this.teamId, kw, me)) {
        this.keyring.set(k.keyId, k.key);
        this.entityCache = undefined;
        this.positionCache = undefined;
      }
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

  /**
   * The data view. Entities are maintained incrementally; positions are
   * recomputed from the (≤ one per member) live ephemeral ops on each read.
   */
  data(now = this.now): TeamData {
    // A read folds anything deferred (bounded by how often the app reads).
    this.flush(now);
    if (this.entityCache === undefined) {
      const fresh = emptyData();
      for (const op of this.state.data) applyDataOp(fresh, this.state, op, (o) => this.decode(o));
      this.entityCache = fresh;
    }
    const cached = this.positionCache;
    if (cached === undefined || cached.state !== this.state || now >= cached.validUntil) {
      const scratch = emptyData();
      let validUntil = Infinity;
      for (const op of this.log.liveEphemeral(now)) {
        if (!admitEphemeral(this.state, op)) continue;
        applyDataOp(scratch, this.state, op, (o) => this.decode(o));
        validUntil = Math.min(validUntil, expiresAt(op.env) ?? Infinity);
      }
      this.positionCache = { state: this.state, validUntil, view: scratch.positions };
    }
    this.entityCache.positions = this.positionCache!.view;
    return this.entityCache;
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
