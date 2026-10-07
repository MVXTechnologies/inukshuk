import { concatBytes, fromB64uLen, isB64uLen, toB64u, utf8, utf8Decode } from './bytes';
import { canonicalize, hasOnlyKeys, isRecord, parseJson, type Json } from './canonical';
import {
  derive,
  KEY_BYTES,
  label,
  NONCE_BYTES,
  safeOpen,
  safeShared,
  safeVerify,
  SIG_BYTES,
  type DeviceKeys,
  type TeamCrypto,
} from './crypto';
import { compareOps } from './membership';
import type { SignedOp } from './envelope';
import { isMemberId, isTeamId, memberPublicKey } from './ids';
import { JOIN_PROOF_KEYS, parseJoinProof, type JoinProof } from './invite';
import { missingRanges, type VersionVector } from './log';
import { categoryOf, LAN_LIMITS, PeerGuard, type PeerLimits, type StrikeReason } from './ratelimit';
import type { IngestReport } from './replica';

/**
 * The sync session (#589, deliverable 6): one connection between two peers,
 * as a pure state machine. The transport (`modules/inukshuk-mesh`: LAN/hotspot
 * TCP now, Nostr relays later) only moves opaque byte frames, in order, and
 * calls {@link SyncSession.receive}; every frame to send comes back in a
 * {@link Step}. No timers, sockets or clocks inside — `now` is passed in.
 *
 * ## Handshake (3 frames, SIGMA-style)
 * ```
 * I → R  hi1 {v, tm, e:ephI, nn:nonce}
 * R → I  hi2 {e:ephR, id:R, mc:MAC_r(R), sg:Sign_R(T2)}   T2 = H("hs2" ‖ hi1 ‖ {e,id})
 * I → R  hi3 {id:I, mc:MAC_i(I), join?, sg:Sign_I(T3)}     T3 = H("hs3" ‖ T2 ‖ hi3−sg)
 * DH = X25519(ephI, ephR);  MAC_x(id) = HMAC(HKDF(DH, T2, "confirm-x"), id)
 * keys:  k_i2r / k_r2i = HKDF(DH, salt=T3, "i2r"/"r2i")
 * ```
 * Each side signs a transcript holding both ephemeral keys and MACs its own
 * identity under the DH secret (SIGMA), so neither side can be impersonated
 * and a relay cannot splice its identity into someone else's session. The responder only talks on to an active member, or to a joiner
 * whose invite proof it can turn into an `m.admit`. After the handshake every
 * frame is XChaCha20-Poly1305 with a per-direction counter nonce: frames
 * cannot be read, altered, replayed or reordered by anyone on the Wi-Fi.
 *
 * ## Sync (anti-entropy)
 * Both sides send their version vector. Each side *pulls* what it lacks with
 * `want` ranges (owner/admin authors first, so membership arrives before the
 * data that depends on it); the other serves them in total order, in frames
 * under the size cap. New local ops are *pushed* as unsolicited `ops` frames.
 * Because ops are content-addressed and merges are idempotent, any phone can
 * relay any other phone's ops, and the result does not depend on the path.
 *
 * ## Abuse
 * A {@link PeerGuard} caps frame size (checked before decrypting), bytes and
 * frames per second, and unsolicited ops per category; malformed frames, bad
 * signatures and protocol violations are strikes, and enough strikes close the
 * session with a ban. Nothing a peer sends can make this class throw.
 */
export type SessionSide = 'initiator' | 'responder';
export type SessionPhase = 'await-hi1' | 'await-hi2' | 'await-hi3' | 'open' | 'closed';

/** What the session needs from the local replica (`TeamReplica` satisfies it). */
export interface SyncStore {
  readonly teamId: string;
  readonly keys: DeviceKeys;
  readonly id: string;
  readonly state: { readonly owner?: string };
  versionVector(): VersionVector;
  opsInRange(author: string, from: number, to: number): SignedOp[];
  liveEphemeral(now: number): SignedOp[];
  ingest(raws: readonly unknown[], now: number): IngestReport;
  isActiveMember(memberId: string): boolean;
  admit(proof: JoinProof, now: number): { op: SignedOp } | { error: string };
}

export type SessionEvent =
  | { type: 'open'; peer: string; joining: boolean }
  | { type: 'ingested'; report: IngestReport }
  | { type: 'admitted'; member: string; op: SignedOp }
  | { type: 'strike'; reason: StrikeReason }
  | { type: 'closed'; why: string };

export interface Step {
  send: Uint8Array[];
  events: SessionEvent[];
}

export interface SessionOptions {
  limits?: PeerLimits;
  /** Initiator only: join with this invite proof instead of as a member. */
  join?: JoinProof;
}

export const MAX_WANT_RANGES = 64;
export const MAX_RANGE_LEN = 1024;
export const MAX_OPS_PER_FRAME = 1024;
/** Ops served per `want` (the requester asks again for the rest). */
export const MAX_SERVE_OPS = 4096;
/** Room left in a frame for the JSON around the ops and the AEAD tag. */
const FRAME_OVERHEAD = 256;

const empty = (): Step => ({ send: [], events: [] });

function clear(obj: Json): Uint8Array {
  return utf8(canonicalize(obj)!);
}

function parseFrame(bytes: Uint8Array): Record<string, unknown> | undefined {
  const text = utf8Decode(bytes);
  const value = text === undefined ? undefined : parseJson(text);
  return isRecord(value) && typeof value['t'] === 'string' ? value : undefined;
}

function counterNonce(n: number): Uint8Array {
  // 64-bit big-endian counter in the last 8 bytes (no BigInt: older Hermes builds).
  const nonce = new Uint8Array(NONCE_BYTES);
  const view = new DataView(nonce.buffer);
  view.setUint32(NONCE_BYTES - 8, Math.floor(n / 2 ** 32));
  view.setUint32(NONCE_BYTES - 4, n >>> 0);
  return nonce;
}

const FRAME_AAD = utf8('inukshuk/team/v1/frame');

export class SyncSession {
  phase: SessionPhase;
  /** The authenticated peer member id (after the handshake). */
  peer: string | undefined;
  readonly guard: PeerGuard;

  private ephSecret: Uint8Array | undefined;
  private hi1: Json | undefined;
  private t2: Uint8Array | undefined;
  private sendKey: Uint8Array | undefined;
  private recvKey: Uint8Array | undefined;
  private sendCounter = 0;
  private recvCounter = 0;
  private peerVv: VersionVector | undefined;
  /** Ranges we asked for and have not fully received: author → highest wanted seq. */
  private outstanding = new Map<string, number>();
  /** Whether we still need to confirm the peer's membership (we joined before knowing the team). */
  private peerUnverified = false;

  private constructor(
    private readonly c: TeamCrypto,
    private readonly store: SyncStore,
    readonly side: SessionSide,
    private readonly options: SessionOptions,
  ) {
    this.guard = new PeerGuard(options.limits ?? LAN_LIMITS);
    this.phase = side === 'initiator' ? 'await-hi2' : 'await-hi1';
  }

  /** Dial a peer: returns the session and the hello frame to send. */
  static initiate(
    c: TeamCrypto,
    store: SyncStore,
    options: SessionOptions = {},
  ): { session: SyncSession; step: Step } {
    const s = new SyncSession(c, store, 'initiator', options);
    s.ephSecret = c.randomBytes(KEY_BYTES);
    s.hi1 = {
      t: 'hi1',
      v: 1,
      tm: store.teamId,
      e: toB64u(c.x25519.publicKey(s.ephSecret)),
      nn: toB64u(c.randomBytes(16)),
    };
    return { session: s, step: { send: [clear(s.hi1)], events: [] } };
  }

  /** Accept a connection: waits for the peer's hello. */
  static respond(c: TeamCrypto, store: SyncStore, options: SessionOptions = {}): SyncSession {
    return new SyncSession(c, store, 'responder', options);
  }

  get bannedUntil(): number | undefined {
    return this.guard.bannedUntil;
  }

  /** Handle one frame from the peer. Total: never throws. */
  receive(frame: Uint8Array, now: number): Step {
    const step = empty();
    if (this.phase === 'closed') return step;
    try {
      const admit = this.guard.admitFrame(frame.length, now);
      if (admit !== 'ok') {
        this.strike(step, admit, now);
        return step;
      }
      if (this.phase === 'open') this.onSealed(frame, now, step);
      else this.onHandshake(frame, now, step);
    } catch {
      this.strike(step, 'malformed', now);
    }
    return step;
  }

  /** Gossip ops we just accepted or wrote to this peer (unsolicited push). */
  push(ops: readonly SignedOp[]): Step {
    const step = empty();
    if (this.phase !== 'open') return step;
    const fresh = ops.filter(
      (op) => op.env.sq === 0 || (this.peerVv?.[op.env.au] ?? 0) < op.env.sq,
    );
    this.sendOps(fresh, false, step);
    for (const op of fresh) {
      if (op.env.sq > 0 && this.peerVv) {
        // Optimistically assume contiguous delivery so we don't re-push.
        const have = this.peerVv[op.env.au] ?? 0;
        if (op.env.sq === have + 1) this.peerVv[op.env.au] = op.env.sq;
      }
    }
    return step;
  }

  /** Periodic re-sync: resend our vector so the peer can pull anything it missed. */
  tick(): Step {
    const step = empty();
    if (this.phase === 'open') this.sendSealed({ t: 'vv', v: this.store.versionVector() }, step);
    return step;
  }

  close(why = 'bye'): Step {
    const step = empty();
    if (this.phase === 'closed') return step;
    if (this.phase === 'open') this.sendSealed({ t: 'bye', why }, step);
    else step.send.push(clear({ t: 'bye', why }));
    this.finish(step, why);
    return step;
  }

  // ── Handshake ─────────────────────────────────────────────────────────────

  private onHandshake(frame: Uint8Array, now: number, step: Step): void {
    const f = parseFrame(frame);
    if (f === undefined) return this.strike(step, 'malformed', now);
    if (f['t'] === 'bye')
      return this.finish(step, typeof f['why'] === 'string' ? f['why'].slice(0, 64) : 'bye');
    if (this.phase === 'await-hi1' && f['t'] === 'hi1') return this.onHi1(f, now, step);
    if (this.phase === 'await-hi2' && f['t'] === 'hi2') return this.onHi2(f, now, step);
    if (this.phase === 'await-hi3' && f['t'] === 'hi3') return this.onHi3(f, now, step);
    this.strike(step, 'protocol', now);
    this.fail(step, 'protocol');
  }

  private onHi1(f: Record<string, unknown>, now: number, step: Step): void {
    if (!hasOnlyKeys(f, ['t', 'v', 'tm', 'e', 'nn']) || f['v'] !== 1 || !isTeamId(f['tm'])) {
      this.strike(step, 'malformed', now);
      return this.fail(step, 'malformed');
    }
    if (f['tm'] !== this.store.teamId) return this.fail(step, 'team');
    const peerEph = fromB64uLen(f['e'], KEY_BYTES);
    if (peerEph === undefined || !isB64uLen(f['nn'], 16)) {
      this.strike(step, 'malformed', now);
      return this.fail(step, 'malformed');
    }
    this.hi1 = f as unknown as Json;
    this.ephSecret = this.c.randomBytes(KEY_BYTES);
    const shared = safeShared(this.c, this.ephSecret, peerEph);
    if (shared === undefined) {
      this.strike(step, 'malformed', now);
      return this.fail(step, 'auth');
    }
    const e = toB64u(this.c.x25519.publicKey(this.ephSecret));
    const id = this.store.id;
    this.t2 = this.transcript2(this.hi1, e, id);
    const sg = toB64u(this.c.ed25519.sign(this.t2, this.store.keys.signSecret));
    const mc = this.identityMac(shared, this.t2, id, 'r');
    step.send.push(clear({ t: 'hi2', e, id, mc, sg }));
    this.phase = 'await-hi3';
  }

  private onHi2(f: Record<string, unknown>, now: number, step: Step): void {
    if (!hasOnlyKeys(f, ['t', 'e', 'id', 'mc', 'sg']) || !isMemberId(f['id'])) {
      this.strike(step, 'malformed', now);
      return this.fail(step, 'malformed');
    }
    const peerEph = fromB64uLen(f['e'], KEY_BYTES);
    const t2 = this.transcript2(this.hi1!, f['e'] as string, f['id']);
    if (!safeVerify(this.c, fromB64uLen(f['sg'], SIG_BYTES), t2, memberPublicKey(f['id']))) {
      this.strike(step, 'signature', now);
      return this.fail(step, 'auth');
    }
    const shared = peerEph && safeShared(this.c, this.ephSecret!, peerEph);
    if (shared === undefined || f['mc'] !== this.identityMac(shared, t2, f['id'], 'r')) {
      this.strike(step, 'signature', now);
      return this.fail(step, 'auth');
    }
    // A joiner cannot check membership yet (it has no log); a member can and must.
    const knowsTeam = this.store.state.owner !== undefined;
    if (knowsTeam && !this.store.isActiveMember(f['id'])) return this.fail(step, 'peer-not-member');
    if (f['id'] === this.store.id) return this.fail(step, 'self');
    const join = this.options.join;
    const myId = join ? join.m : this.store.id;
    // SIGMA's MAC: binds my identity to the DH secret, so a relay cannot swap in its own.
    const hi3: Record<string, Json> = {
      t: 'hi3',
      id: myId,
      mc: this.identityMac(shared, t2, myId, 'i'),
    };
    if (join) hi3['join'] = join as unknown as Json;
    const t3 = this.transcript3(t2, hi3);
    hi3['sg'] = toB64u(this.c.ed25519.sign(t3, this.store.keys.signSecret));
    step.send.push(clear(hi3));
    this.deriveKeys(shared, t3);
    this.peer = f['id'];
    this.peerUnverified = !knowsTeam;
    this.open(step, join !== undefined, now);
  }

  private onHi3(f: Record<string, unknown>, now: number, step: Step): void {
    if (!hasOnlyKeys(f, ['t', 'id', 'mc', 'join', 'sg']) || !isMemberId(f['id'])) {
      this.strike(step, 'malformed', now);
      return this.fail(step, 'malformed');
    }
    const unsigned = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'sg')) as Record<
      string,
      Json
    >;
    const t3 = this.transcript3(this.t2!, unsigned);
    if (!safeVerify(this.c, fromB64uLen(f['sg'], SIG_BYTES), t3, memberPublicKey(f['id']))) {
      this.strike(step, 'signature', now);
      return this.fail(step, 'auth');
    }
    const peerEph = fromB64uLen((this.hi1 as Record<string, unknown>)['e'], KEY_BYTES);
    const shared = peerEph && safeShared(this.c, this.ephSecret!, peerEph);
    if (shared === undefined || f['mc'] !== this.identityMac(shared, this.t2!, f['id'], 'i')) {
      this.strike(step, 'signature', now);
      return this.fail(step, 'auth');
    }
    if (f['id'] === this.store.id) return this.fail(step, 'self');
    if (f['join'] !== undefined) {
      const raw = f['join'];
      const proof =
        isRecord(raw) && hasOnlyKeys(raw, JOIN_PROOF_KEYS) ? parseJoinProof(raw) : undefined;
      if (proof === undefined || proof.m !== f['id']) {
        this.strike(step, 'malformed', now);
        return this.fail(step, 'malformed');
      }
      if (!this.store.isActiveMember(proof.m)) {
        const res = this.store.admit(proof, now);
        if ('error' in res) return this.fail(step, `join-${res.error}`);
        step.events.push({ type: 'admitted', member: proof.m, op: res.op });
      }
    } else if (!this.store.isActiveMember(f['id'])) {
      return this.fail(step, 'not-member');
    }
    this.deriveKeys(shared, t3);
    this.peer = f['id'];
    this.open(step, f['join'] !== undefined, now);
  }

  private transcript2(hi1: Json, e: string, id: string): Uint8Array {
    return this.c.sha256(concatBytes(label('hs2'), clear(hi1), clear({ e, id })));
  }

  private transcript3(t2: Uint8Array, hi3: Json): Uint8Array {
    return this.c.sha256(concatBytes(label('hs3'), t2, clear(hi3)));
  }

  /** SIGMA's identity MAC: proves the signer of this side also holds the DH secret. */
  private identityMac(shared: Uint8Array, t2: Uint8Array, id: string, side: 'i' | 'r'): string {
    const key = derive(this.c, shared, t2, `confirm-${side}`);
    return toB64u(this.c.hmacSha256(key, utf8(id)));
  }

  private deriveKeys(shared: Uint8Array, t3: Uint8Array): void {
    const i2r = derive(this.c, shared, t3, 'i2r');
    const r2i = derive(this.c, shared, t3, 'r2i');
    [this.sendKey, this.recvKey] = this.side === 'initiator' ? [i2r, r2i] : [r2i, i2r];
    this.ephSecret = undefined;
  }

  private open(step: Step, joining: boolean, now: number): void {
    this.phase = 'open';
    step.events.push({ type: 'open', peer: this.peer!, joining });
    this.sendSealed({ t: 'vv', v: this.store.versionVector() }, step);
    this.sendOps(this.store.liveEphemeral(now), false, step);
  }

  // ── Open phase ────────────────────────────────────────────────────────────

  private sendSealed(obj: Json, step: Step): void {
    const plain = clear(obj);
    step.send.push(
      this.c.aead.seal(this.sendKey!, counterNonce(this.sendCounter++), plain, FRAME_AAD),
    );
  }

  private onSealed(frame: Uint8Array, now: number, step: Step): void {
    const plain = safeOpen(this.c, this.recvKey!, counterNonce(this.recvCounter), frame, FRAME_AAD);
    if (plain === undefined) {
      // A responder that refused our hi3 answers with a clear bye before any sealed frame.
      const refusal = this.recvCounter === 0 ? parseFrame(frame) : undefined;
      if (refusal?.['t'] === 'bye') {
        return this.finish(
          step,
          typeof refusal['why'] === 'string' ? refusal['why'].slice(0, 64) : 'bye',
        );
      }
      // Tampered, replayed or reordered: the stream is no longer trustworthy.
      this.strike(step, 'decrypt', now);
      return this.fail(step, 'decrypt');
    }
    this.recvCounter++;
    const f = parseFrame(plain);
    if (f === undefined) return this.strike(step, 'malformed', now);
    switch (f['t']) {
      case 'vv':
        return this.onVv(f, now, step);
      case 'want':
        return this.onWant(f, now, step);
      case 'ops':
        return this.onOps(f, now, step);
      case 'bye':
        return this.finish(step, typeof f['why'] === 'string' ? f['why'].slice(0, 64) : 'bye');
      default:
        return this.strike(step, 'protocol', now);
    }
  }

  private onVv(f: Record<string, unknown>, now: number, step: Step): void {
    const v = f['v'];
    if (!hasOnlyKeys(f, ['t', 'v']) || !isRecord(v) || Object.keys(v).length > 4096) {
      return this.strike(step, 'malformed', now);
    }
    const vv: VersionVector = {};
    for (const [author, n] of Object.entries(v)) {
      if (!isMemberId(author) || !Number.isSafeInteger(n) || (n as number) < 1) {
        return this.strike(step, 'malformed', now);
      }
      vv[author] = n as number;
    }
    this.peerVv = vv;
    this.outstanding.clear();
    this.requestMissing(step);
  }

  /** Ask for what the peer has and we don't, membership-relevant authors first. */
  private requestMissing(step: Step): void {
    if (this.peerVv === undefined) return;
    const mine = this.store.versionVector();
    const missing = missingRanges(mine, this.peerVv).filter(
      ([a, , to]) => (this.outstanding.get(a) ?? 0) < to,
    );
    if (missing.length === 0) return;
    const owner = this.store.state.owner;
    const rank = (a: string) => (a === owner ? 0 : this.store.isActiveMember(a) ? 1 : 2);
    missing.sort((x, y) => rank(x[0]) - rank(y[0]));
    const ranges = missing
      .slice(0, MAX_WANT_RANGES)
      .map(([a, from, to]): [string, number, number] => [
        a,
        from,
        Math.min(to, from + MAX_RANGE_LEN - 1),
      ]);
    for (const [a, , to] of ranges) this.outstanding.set(a, to);
    this.sendSealed({ t: 'want', r: ranges }, step);
  }

  private onWant(f: Record<string, unknown>, now: number, step: Step): void {
    const r = f['r'];
    if (
      !hasOnlyKeys(f, ['t', 'r']) ||
      !Array.isArray(r) ||
      r.length === 0 ||
      r.length > MAX_WANT_RANGES
    ) {
      return this.strike(step, 'malformed', now);
    }
    const out: SignedOp[] = [];
    for (const range of r as unknown[]) {
      if (!Array.isArray(range) || range.length !== 3) return this.strike(step, 'malformed', now);
      const [a, from, to] = range as unknown[];
      if (!isMemberId(a) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
        return this.strike(step, 'malformed', now);
      }
      if (
        (from as number) < 1 ||
        (to as number) < (from as number) ||
        (to as number) - (from as number) >= MAX_RANGE_LEN
      ) {
        return this.strike(step, 'malformed', now);
      }
      out.push(...this.store.opsInRange(a, from as number, to as number));
      if (out.length >= MAX_SERVE_OPS) break;
    }
    // Total order: membership ops precede the data that depends on them.
    this.sendOps(out.sort(compareOps).slice(0, MAX_SERVE_OPS), true, step);
  }

  private onOps(f: Record<string, unknown>, now: number, step: Step): void {
    const o = f['o'];
    if (!hasOnlyKeys(f, ['t', 'o', 're']) || !Array.isArray(o) || o.length > MAX_OPS_PER_FRAME) {
      return this.strike(step, 'malformed', now);
    }
    const solicited = f['re'] === 1;
    const admitted: unknown[] = [];
    let overRate = false;
    for (const raw of o as unknown[]) {
      const env = isRecord(raw) ? raw : undefined;
      const author = env?.['au'];
      const sq = env?.['sq'];
      const asked =
        solicited &&
        typeof author === 'string' &&
        typeof sq === 'number' &&
        sq <= (this.outstanding.get(author) ?? 0);
      if (!asked && !this.guard.admitOp(categoryOf(String(env?.['t'] ?? '')), now)) {
        overRate = true;
        continue;
      }
      admitted.push(raw);
    }
    if (overRate) this.strike(step, 'rate', now);
    if (admitted.length > 0) {
      const report = this.store.ingest(admitted, now);
      step.events.push({ type: 'ingested', report });
      const forged = report.rejected.filter((x) => x.reason === 'signature').length;
      const junk = report.rejected.filter((x) =>
        ['not-object', 'unknown-field', 'version', 'shape', 'too-large', 'type', 'author'].includes(
          x.reason,
        ),
      ).length;
      if (forged > 0) this.strike(step, 'signature', now);
      if (junk > 0) this.strike(step, 'malformed', now);
      if (this.phase === 'closed') return;
    }
    if (this.peerUnverified && this.store.state.owner !== undefined) {
      this.peerUnverified = false;
      if (!this.store.isActiveMember(this.peer!)) return this.fail(step, 'peer-not-member');
    }
    if (solicited) {
      const vv = this.store.versionVector();
      for (const [a, to] of [...this.outstanding])
        if ((vv[a] ?? 0) >= to) this.outstanding.delete(a);
      // Ask for the next slice once this round is in (a peer that sends nothing stalls only itself).
      if (this.outstanding.size === 0) this.requestMissing(step);
    }
  }

  private sendOps(ops: readonly SignedOp[], solicited: boolean, step: Step): void {
    const budget = this.guard.limits.maxFrameBytes - FRAME_OVERHEAD;
    let batch: Json[] = [];
    let size = 0;
    const flush = () => {
      if (batch.length === 0) return;
      const frame: Record<string, Json> = { t: 'ops', o: batch };
      if (solicited) frame['re'] = 1;
      this.sendSealed(frame, step);
      batch = [];
      size = 0;
    };
    for (const op of ops) {
      if (size + op.bytes + 1 > budget || batch.length >= MAX_OPS_PER_FRAME) flush();
      batch.push(op.env as unknown as Json);
      size += op.bytes + 1;
    }
    flush();
  }

  // ── Endings ───────────────────────────────────────────────────────────────

  private strike(step: Step, reason: StrikeReason, now: number): void {
    step.events.push({ type: 'strike', reason });
    if (this.guard.strike(now) && this.phase !== 'closed') this.fail(step, 'banned');
  }

  private fail(step: Step, why: string): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'open') this.sendSealed({ t: 'bye', why }, step);
    else step.send.push(clear({ t: 'bye', why }));
    this.finish(step, why);
  }

  private finish(step: Step, why: string): void {
    this.phase = 'closed';
    this.sendKey = undefined;
    this.recvKey = undefined;
    step.events.push({ type: 'closed', why });
  }
}
