import { concatBytes, fromB64u, fromB64uLen, isB64uLen, toB64u, utf8, utf8Decode } from './bytes';
import { dict, own } from './crdt';
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
import {
  categoryOf,
  LAN_LIMITS,
  PeerGuard,
  TokenBucket,
  type OpCategory,
  type PeerLimits,
  type StrikeReason,
} from './ratelimit';
import type { IngestReport } from './replica';
import { laneOfOp, LANE_LIVE, LANE_SYNC, LANE_URGENT, LANES, type Lane } from '../group/lanes';

/**
 * The sync session (#589, deliverable 6): one connection between two peers,
 * as a pure state machine. The transport (`modules/inukshuk-mesh`: LAN/hotspot
 * TCP now, Nostr relays later) only moves opaque byte frames, in order, and
 * calls {@link SyncSession.receive}; every frame to send comes back in a
 * {@link Step}. No timers, sockets or clocks inside — `now` is passed in.
 *
 * ## Handshake (3 frames, SIGMA-style, identities hidden)
 * ```
 * I → R  hi1 {v, tm, e:ephI, cm:H("commit" ‖ nI)}
 * R → I  hi2 {e:ephR, x:Seal(hs-r){id:R, mc:MAC_r(R), sg:Sign_R(T2)}}
 * I → R  hi3 {x:Seal(hs-i){id:I, mc:MAC_i(I), nn:nI, join?, sg:Sign_I(T3)}}
 * DH = X25519(ephI, ephR)   T1 = H("hs1" ‖ hi1 ‖ ephR)
 * T2 = H("hs2" ‖ T1 ‖ {id:R})   T3 = H("hs3" ‖ T2 ‖ hi3 inner − sg)
 * hs-r / hs-i = HKDF(DH, T1|T2);  MAC_x(id) = HMAC(HKDF(DH, T2, "confirm-x"), id)
 * keys: k_i2r / k_r2i = HKDF(DH, T3)
 * safety code = HKDF(DH, H("sas" ‖ cm ‖ nI ‖ ephI ‖ ephR), "safety") → 6 digits
 * ```
 * Each side signs a transcript holding both ephemeral keys and MACs its own
 * identity under the DH secret (SIGMA), so neither side can be impersonated
 * and a relay cannot splice its identity into someone else's session.
 * Identities and join proofs travel encrypted: a passive listener sees two
 * ephemeral keys and the team id. The initiator commits to a nonce (`cm`)
 * before seeing the responder's key and reveals it last, so a man in the
 * middle holding an invite cannot grind the 6-digit safety code offline: each
 * of its two sessions yields an independent random code (1 in 10^6 to match).
 * The responder only talks on to an active member, or to a joiner whose
 * invite proof it can turn into an `m.admit`. After the handshake every frame
 * is XChaCha20-Poly1305 with a per-direction counter nonce: frames cannot be
 * read, altered, replayed or reordered by anyone on the Wi-Fi.
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
 *
 * ## Seal on dequeue (2.7.0, design §4.4)
 * Frames are sealed with a counter nonce, so once sealed they cannot be
 * reordered. In **pull mode** ({@link SessionOptions.pull}) the session keeps
 * one plaintext outbox per priority lane (`@core/group/lanes`) and seals a
 * frame only when the link layer takes it ({@link SyncSession.nextFrame}):
 * an SOS written behind thousands of queued catch-up ops is the next frame
 * sealed. Wire bytes and per-session ordering rules are unchanged; only which
 * plaintext goes next changes. Without `pull` (the default, every 2.6 caller)
 * every frame is sealed at once and returned in {@link Step.send}, as before.
 *
 * ## Capability-gated frames (2.7.0, design §2.6, review R-RTC-1)
 * `up`/`upok` (LAN upgrade from raw v1 framing to the link multiplexer) and
 * `rtc` (WebRTC offer/answer/ICE, only ever inside this AEAD) are sent only to
 * a peer whose `cap` record claims `lnk` / `rtc`, and accepted only when this
 * session was told to speak them. A 2.6 peer never claims either, so it never
 * sees one; a session not told to speak them strikes them as before.
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
  /** Fold anything the store deferred (called from {@link SyncSession.tick}). */
  flush?(now: number): void;
  /**
   * Whether `member` advertises capability `cap` at `now` (a logged, unexpired
   * `cap` record, #683). Absent: no peer has any, and gated ops are never sent.
   */
  canReceive?(member: string, cap: string, now: number): boolean;
}

/**
 * Op types a peer only receives when its member advertises the capability
 * (#683). Peers before 2.5.2 refuse an unknown ephemeral type and strike the
 * sender for it; 4 strokes a second would get the drawer banned in seconds.
 */
export const GATED_TYPES: Readonly<Record<string, string>> = { pen: 'pen' };

export type SessionEvent =
  | { type: 'open'; peer: string; joining: boolean }
  | { type: 'ingested'; report: IngestReport }
  | { type: 'admitted'; member: string; op: SignedOp }
  | { type: 'strike'; reason: StrikeReason }
  /** WebRTC signalling from the authenticated, active peer (cap `rtc`). */
  | { type: 'rtc'; signal: RtcSignal }
  /** Both directions of this connection now use link-mux framing (after `up`/`upok`). */
  | { type: 'upgrade' }
  | { type: 'closed'; why: string };

/** Capability a peer claims to accept the LAN `up` upgrade to link-mux framing. */
export const LINK_CAP = 'lnk';
/** Capability a peer claims to accept `rtc` signalling frames. */
export const RTC_CAP = 'rtc';

/** Largest SDP an `rtc` frame carries (an offer with one data channel is ~1–3 KiB). */
export const MAX_RTC_SDP = 16 * 1024;
/** Largest ICE candidate line. */
export const MAX_RTC_CANDIDATE = 1024;
/** `rtc` frames a peer may send: [per second, burst]. ICE trickles a few dozen per attempt. */
export const RTC_RATE: [number, number] = [4, 64];
/**
 * Share of the peer's unsolicited-op budget a pull-mode session spends on
 * pushes; beyond it the peer pulls (`vv` → `want`), which is never rate-struck.
 */
export const PUSH_SHARE = 0.5;
/** Pull mode: a `want` that served nothing for this long is asked again on the next vector. */
export const WANT_STALE_MS = 30_000;
/** An `up` that gets no `upok` this long ends the session. */
export const UPGRADE_TIMEOUT_MS = 30_000;

/**
 * WebRTC signalling (review R-RTC-1): it travels only inside this session's
 * AEAD, keyed by a handshake both member identities signed.
 */
export type RtcSignal =
  { k: 'offer' | 'answer'; sdp: string } | { k: 'ice'; c: string; mid?: string; ix?: number };

/** Total parse of a received `rtc` frame body; `undefined` when malformed. */
export function parseRtcSignal(f: Record<string, unknown>): RtcSignal | undefined {
  const k = f['k'];
  if (k === 'offer' || k === 'answer') {
    if (!hasOnlyKeys(f, ['t', 'k', 'sdp'])) return undefined;
    const sdp = f['sdp'];
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_RTC_SDP) return undefined;
    return { k, sdp };
  }
  if (k === 'ice') {
    if (!hasOnlyKeys(f, ['t', 'k', 'c', 'mid', 'ix'])) return undefined;
    const cand = f['c'];
    const mid = f['mid'];
    const ix = f['ix'];
    if (typeof cand !== 'string' || cand.length > MAX_RTC_CANDIDATE) return undefined;
    if (mid !== undefined && (typeof mid !== 'string' || mid.length > 64)) return undefined;
    if (
      ix !== undefined &&
      (!Number.isSafeInteger(ix) || (ix as number) < 0 || (ix as number) > 255)
    ) {
      return undefined;
    }
    const out: RtcSignal = { k, c: cand };
    if (mid !== undefined) out.mid = mid as string;
    if (ix !== undefined) out.ix = ix as number;
    return out;
  }
  return undefined;
}

export interface Step {
  send: Uint8Array[];
  events: SessionEvent[];
}

export interface SessionOptions {
  limits?: PeerLimits;
  /** Initiator only: join with this invite proof instead of as a member. */
  join?: JoinProof;
  /** When the session started (initiator); otherwise the first received frame's time. */
  now?: number;
  /** The handshake must finish within this long (default {@link HANDSHAKE_TIMEOUT_MS}). */
  handshakeTimeoutMs?: number;
  /**
   * Whether this transport may carry live strokes (`pen`, #683) at all. Off by
   * default (fail closed): only a first-party link between teammates' phones
   * (the LAN mesh) turns it on, never a transport shared with strangers such
   * as a Nostr relay. Even then a stroke goes only to a capable peer.
   */
  carryLiveStrokes?: boolean;
  /**
   * Members this phone stops sending live strokes to (#683), shared by every
   * session of one team for as long as it is open. A session adds its peer
   * when it ends from the far side (a ban included) while strokes were in
   * flight: a phone rolled back to 2.5.1 keeps a claim it can no longer
   * honour until that claim expires, and strikes on every stroke meanwhile.
   */
  liveStrokeMute?: Set<string>;
  /**
   * Seal on dequeue (2.7 link layer): sealed frames wait as plaintext in one
   * outbox per lane and are sealed by {@link SyncSession.nextFrame}; clear
   * frames (handshake, a refusal) wait in front of them. `Step.send` stays
   * empty. Off (default): every frame is sealed at once into `Step.send`.
   */
  pull?: boolean;
  /**
   * Speak the LAN upgrade to link-mux framing (`up`/`upok`). Needs `pull`
   * (the session holds its output between `up` and `upok`). The initiator
   * offers it only to a peer claiming {@link LINK_CAP}.
   */
  linkUpgrade?: boolean;
  /** Carry WebRTC signalling (`rtc` frames), only with a peer claiming {@link RTC_CAP}. */
  rtc?: boolean;
  /**
   * Link capabilities (`lnk`, `rtc`) the peer claims in **any** group the two
   * phones share (#712: a shared folder is its own group, with no team): a
   * claim in this session's own group always counts too.
   */
  claims?: (member: string, cap: string, now: number) => boolean;
  /**
   * Authenticate and signal only (the L0 room session, design §2.3/§2.4): no
   * version vector, no `want`/`ops`, no pushes. The room is never a data
   * relay (review §2.9); a peer that sends sync frames anyway is struck.
   */
  signalOnly?: boolean;
  /**
   * The log only (a joiner's catch-up through an invite room, 2.7.0 G7): no
   * ephemeral op (positions, live strokes) is ever sent on this session.
   */
  logOnly?: boolean;
}

/** A frame waiting in a pull-mode outbox: plaintext until the link takes it. */
interface Outgoing {
  plain: Uint8Array;
  mark?: 'up' | 'upok';
}

/** A session that ends this soon after a live stroke went out mutes its peer (`liveStrokeMute`). */
export const PEN_IN_FLIGHT_MS = 10_000;

/** A handshake that takes longer is dropped (re-review #4: no time to stall and grind). */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

export const MAX_WANT_RANGES = 64;
export const MAX_RANGE_LEN = 1024;
export const MAX_OPS_PER_FRAME = 1024;
/** Follow-up `want` rounds per received vector. */
export const MAX_WANT_ROUNDS = 64;
/** Ops served per `want` (the requester asks again for the rest). */
export const MAX_SERVE_OPS = 4096;
/**
 * Sealed frames the responder keeps while it still waits for hi3. The
 * initiator seals its first frames right behind hi3; a transport that
 * delivers them first must not cost the stream (they decrypt in order once
 * hi3 derived the keys). More than this before hi3 ends the session
 * ('early-frames'): an honest peer sends one or two.
 */
export const MAX_EARLY_FRAMES = 8;
/** Room left in a frame for the JSON around the ops and the AEAD tag. */
const FRAME_OVERHEAD = 256;

const empty = (): Step => ({ send: [], events: [] });

function clear(obj: Json): Uint8Array {
  return utf8(canonicalize(obj)!);
}

function parseFrameObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  const text = utf8Decode(bytes);
  const value = text === undefined ? undefined : parseJson(text);
  return isRecord(value) ? value : undefined;
}

function parseFrame(bytes: Uint8Array): Record<string, unknown> | undefined {
  const value = parseFrameObject(bytes);
  return value !== undefined && typeof value['t'] === 'string' ? value : undefined;
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
  private ephR: string | undefined;
  private revealed: Uint8Array | undefined;
  private startedAt: number | undefined;
  private shared: Uint8Array | undefined;
  private commitNonce: Uint8Array | undefined;
  private hi1: Json | undefined;
  private t1: Uint8Array | undefined;
  private t2: Uint8Array | undefined;
  /**
   * Six digits both people can compare out loud after the handshake (review
   * M3): derived from this session's DH secret and full transcript.
   */
  safetyCode: string | undefined;
  private sendKey: Uint8Array | undefined;
  private recvKey: Uint8Array | undefined;
  private sendCounter = 0;
  private recvCounter = 0;
  /** Sealed frames that overtook hi3 (responder): replayed in order once open. */
  private early: Uint8Array[] = [];
  private peerVv: VersionVector | undefined;
  /** Ranges we asked for and have not fully received: author → highest wanted seq. */
  private outstanding = new Map<string, number>();
  /** Pull mode: when each outstanding request was made or last served an op. */
  private wantProgress = new Map<string, number>();
  /**
   * Pull mode: the highest seq asked of this peer per author, kept until the
   * peer has served through it. A range can complete through another peer
   * first (a faster path); this peer's copies still on the way answered our
   * `want` and must not be judged unsolicited (found by the G6 simulator).
   */
  private asked = new Map<string, number>();
  /** `want` rounds since the peer's last vector (bounds re-requests while chains re-pin). */
  private wantRounds = 0;
  /** Whether we still need to confirm the peer's membership (we joined before knowing the team). */
  private peerUnverified = false;
  /** The latest time this session was told (capability claims expire against it). */
  private clock = 0;
  /** When a live stroke last went to the peer. */
  private lastPenAt: number | undefined;
  /** Pull mode: clear frames that leave before anything sealed (handshake, refusals, the last bye). */
  private pre: Uint8Array[] = [];
  /** Pull mode: plaintext frames per lane, sealed when the link takes them. */
  private outbox: Outgoing[][] = [[], [], [], []];
  /** LAN upgrade progress: `offered` = `up` queued, `sent` = `up` sealed, waiting for `upok`. */
  private upgrade: 'none' | 'offered' | 'sent' | 'done' = 'none';
  /** Initiator between sealing `up` and receiving `upok`: nothing else may leave in v1 framing. */
  private holding = false;
  private upgradeSentAt = 0;
  /** The peer's frames after this point use link-mux framing (`up` processed, or `upok` received). */
  upgradeIn = false;
  /** Our frames after this point use link-mux framing (`upok` sealed, or received). */
  upgradeOut = false;
  private readonly rtcBucket = new TokenBucket(...RTC_RATE);
  /**
   * Pull mode: our share ({@link PUSH_SHARE}) of the peer's budget for
   * unsolicited ops per category (its `PeerGuard`, same constants). Without
   * it, relaying a large catch-up to a third phone over an internet path gets
   * the relaying phone struck and banned (found by the simulator).
   */
  private pushBudget: Record<OpCategory, TokenBucket> | undefined;

  private constructor(
    private readonly c: TeamCrypto,
    private readonly store: SyncStore,
    readonly side: SessionSide,
    private readonly options: SessionOptions,
  ) {
    this.guard = new PeerGuard(options.limits ?? LAN_LIMITS);
    if (options.pull === true) {
      const ops = this.guard.limits.ops;
      const share = ([rate, burst]: [number, number]) =>
        new TokenBucket(rate * PUSH_SHARE, Math.max(1, Math.floor(burst * PUSH_SHARE)));
      this.pushBudget = {
        control: share(ops.control),
        data: share(ops.data),
        msg: share(ops.msg),
        pos: share(ops.pos),
        draw: share(ops.draw),
      };
    }
    this.clock = options.now ?? 0;
    this.phase = side === 'initiator' ? 'await-hi2' : 'await-hi1';
  }

  /** Dial a peer: returns the session and the hello frame to send. */
  static initiate(
    c: TeamCrypto,
    store: SyncStore,
    options: SessionOptions = {},
  ): { session: SyncSession; step: Step } {
    const s = new SyncSession(c, store, 'initiator', options);
    s.startedAt = options.now;
    s.ephSecret = c.randomBytes(KEY_BYTES);
    s.commitNonce = c.randomBytes(16);
    s.hi1 = {
      t: 'hi1',
      v: 1,
      tm: store.teamId,
      e: toB64u(c.x25519.publicKey(s.ephSecret)),
      cm: toB64u(s.commitment(s.commitNonce)),
    };
    const step = empty();
    s.emitClear(step, clear(s.hi1));
    return { session: s, step };
  }

  /** Accept a connection: waits for the peer's hello. */
  static respond(c: TeamCrypto, store: SyncStore, options: SessionOptions = {}): SyncSession {
    return new SyncSession(c, store, 'responder', options);
  }

  private handshakeExpired(now: number): boolean {
    const limit = this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    return (
      this.phase !== 'open' &&
      this.phase !== 'closed' &&
      this.startedAt !== undefined &&
      now - this.startedAt > limit
    );
  }

  get bannedUntil(): number | undefined {
    return this.guard.bannedUntil;
  }

  /** Handle one frame from the peer. Total: never throws. */
  receive(frame: Uint8Array, now: number): Step {
    const step = empty();
    if (this.phase === 'closed') return step;
    this.clock = Math.max(this.clock, now);
    this.startedAt ??= now;
    if (this.handshakeExpired(now)) {
      this.fail(step, 'timeout');
      return step;
    }
    try {
      const admit = this.guard.admitFrame(frame.length, now);
      if (admit !== 'ok') {
        this.strike(step, admit, now);
        return step;
      }
      if (this.phase === 'open') this.onSealed(frame, now, step);
      else this.onHandshake(frame, now, step);
    } catch {
      // Open: the frame's counter is already consumed, so the stream stays in
      // step; a strike. Handshaking: the session cannot know what it half did
      // (an admission written, keys not derived), so it ends, named, rather
      // than wait for an hello that never comes again.
      if (this.phase === 'open') this.strike(step, 'malformed', now);
      else this.fail(step, 'error');
    }
    return step;
  }

  /**
   * Gossip ops we just accepted or wrote to this peer (unsolicited push).
   * `lane` is the writer's classification (`laneOfWrite`): an SOS record looks
   * like any `e.set` from outside. It matters in pull mode only.
   */
  push(ops: readonly SignedOp[], now?: number, lane: Lane = LANE_LIVE): Step {
    const step = empty();
    if (now !== undefined) this.clock = Math.max(this.clock, now);
    if (this.phase !== 'open' || this.options.signalOnly === true) return step;
    const fresh = ops.filter((op) =>
      op.env.sq === 0 ? this.options.logOnly !== true : (this.peerVv?.[op.env.au] ?? 0) < op.env.sq,
    );
    let sent = fresh;
    if (this.options.pull === true) {
      // Each op to its lane: an SOS overtakes whatever waits in lower lanes.
      const byLane: SignedOp[][] = [[], [], [], []];
      sent = [];
      let deferred = false;
      for (const op of fresh) {
        const l = laneOfOp(op, lane);
        if (!this.mayPush(op, l)) {
          // The peer would refuse it as over-rate (a strike). Logged ops are
          // pulled instead (our vector, below); a stale position is just dropped.
          if (op.env.sq > 0) deferred = true;
          continue;
        }
        byLane[l]!.push(op);
        sent.push(op);
      }
      for (const l of LANES) this.sendOps(byLane[l]!, false, step, l);
      if (deferred) this.sendSealed({ t: 'vv', v: this.store.versionVector() }, step, LANE_SYNC);
    } else {
      this.sendOps(fresh, false, step, lane);
    }
    for (const op of sent) {
      if (op.env.sq > 0 && this.peerVv) {
        // Optimistically assume contiguous delivery so we don't re-push.
        const have = this.peerVv[op.env.au] ?? 0;
        if (op.env.sq === have + 1) this.peerVv[op.env.au] = op.env.sq;
      }
    }
    return step;
  }

  /**
   * Whether an unsolicited op fits our share of the peer's budget. Lane 0
   * always goes (it spends the budget when it can): the half we leave unused
   * is its headroom, so an SOS is never refused as over-rate. Live strokes
   * have their own per-author metering at the peer and pass as before.
   */
  private mayPush(op: SignedOp, lane: Lane): boolean {
    const category = categoryOf(op.env.t);
    if (category === 'draw') return true;
    const ok = this.pushBudget![category].take(1, this.clock);
    return ok || lane === LANE_URGENT;
  }

  /** Periodic re-sync: resend our vector so the peer can pull anything it missed. */
  tick(now?: number): Step {
    const step = empty();
    if (now !== undefined) this.clock = Math.max(this.clock, now);
    if (now !== undefined && this.handshakeExpired(now)) {
      this.fail(step, 'timeout');
      return step;
    }
    if (now !== undefined) this.store.flush?.(now);
    if (this.holding && this.clock - this.upgradeSentAt > UPGRADE_TIMEOUT_MS) {
      this.fail(step, 'upgrade-timeout');
      return step;
    }
    if (this.phase === 'open' && this.options.signalOnly !== true) {
      this.sendSealed({ t: 'vv', v: this.store.versionVector() }, step);
    }
    return step;
  }

  // ── Pull mode (seal on dequeue) ───────────────────────────────────────────

  /** Whether a frame waits for `lane` (clear frames count as lane 0). */
  hasPending(lane: Lane): boolean {
    if (lane === LANE_URGENT && this.pre.length > 0) return true;
    return this.phase === 'open' && !this.holding && this.outbox[lane]!.length > 0;
  }

  /** Frames waiting in every lane (pull mode). */
  get pendingFrames(): number {
    return this.pre.length + this.outbox.reduce((n, q) => n + q.length, 0);
  }

  /**
   * Take the next frame of `lane`, sealing it now (pull mode): the counter
   * advances only for a frame actually handed to the link. Clear frames
   * (handshake, refusals, the last bye) always leave first, whatever the lane.
   */
  nextFrame(lane: Lane): Uint8Array | undefined {
    const raw = this.pre.shift();
    if (raw !== undefined) return raw;
    if (this.phase !== 'open' || this.holding) return undefined;
    const out = this.outbox[lane]!.shift();
    if (out === undefined) return undefined;
    const sealed = this.seal(out.plain);
    if (out.mark === 'up') {
      this.upgrade = 'sent';
      this.holding = true;
      this.upgradeSentAt = this.clock;
    } else if (out.mark === 'upok') {
      this.upgradeOut = true;
    }
    return sealed;
  }

  // ── Capability-gated frames ───────────────────────────────────────────────

  /** A link capability claim by `member`, here or in another group both phones share. */
  private linkClaim(member: string, cap: string): boolean {
    return (
      this.store.canReceive?.(member, cap, this.clock) === true ||
      this.options.claims?.(member, cap, this.clock) === true
    );
  }

  /** Whether {@link requestUpgrade} would offer the LAN upgrade now. */
  canUpgrade(now?: number): boolean {
    if (now !== undefined) this.clock = Math.max(this.clock, now);
    return (
      this.options.pull === true &&
      this.options.linkUpgrade === true &&
      this.side === 'initiator' &&
      this.phase === 'open' &&
      this.upgrade === 'none' &&
      this.peer !== undefined &&
      !this.peerUnverified &&
      this.linkClaim(this.peer, LINK_CAP)
    );
  }

  /**
   * Initiator: offer the switch from raw v1 framing to link-mux framing
   * (design §2.6). Once `up` is sealed nothing else leaves until `upok`
   * arrives; then both directions use mux framing (`upgradeIn/Out`).
   */
  requestUpgrade(now?: number): boolean {
    if (!this.canUpgrade(now)) return false;
    this.upgrade = 'offered';
    this.sendSealed({ t: 'up' }, empty(), LANE_URGENT, 'up');
    return true;
  }

  /**
   * Whether `rtc` signalling may go to this peer now (review R-RTC-1/3): the
   * transport speaks it, the peer is authenticated and an active member under
   * our log, claims {@link RTC_CAP}, and we are not a provisional joiner.
   */
  canSignal(now?: number): boolean {
    if (now !== undefined) this.clock = Math.max(this.clock, now);
    return (
      this.options.rtc === true &&
      this.options.join === undefined &&
      this.phase === 'open' &&
      this.peer !== undefined &&
      !this.peerUnverified &&
      this.store.isActiveMember(this.peer) &&
      this.linkClaim(this.peer, RTC_CAP)
    );
  }

  /**
   * How far the peer's last version vector says it holds `author`'s chain
   * (0: nothing; undefined before its first vector). Share live's "changes
   * waiting" (#712).
   */
  peerSeq(author: string): number | undefined {
    return this.peerVv === undefined ? undefined : (this.peerVv[author] ?? 0);
  }

  /** Send WebRTC signalling; nothing when {@link canSignal} is false or the signal is malformed. */
  signal(signal: RtcSignal, now?: number): Step {
    const step = empty();
    if (!this.canSignal(now)) return step;
    const body = { ...signal, t: 'rtc' } as Record<string, unknown>;
    if (parseRtcSignal(body) === undefined) return step;
    this.sendSealed(body as Json, step, LANE_LIVE);
    return step;
  }

  close(why = 'bye'): Step {
    const step = empty();
    if (this.phase === 'closed') return step;
    if (this.phase === 'open') this.sendFinal({ t: 'bye', why }, step);
    else this.emitClear(step, clear({ t: 'bye', why }));
    // Our own decision (backgrounded, a duplicate link): no reason to mute the peer.
    this.lastPenAt = undefined;
    this.finish(step, why);
    return step;
  }

  // ── Handshake ─────────────────────────────────────────────────────────────

  private onHandshake(frame: Uint8Array, now: number, step: Step): void {
    const f = parseFrame(frame);
    if (f === undefined && this.phase === 'await-hi3') {
      // Not JSON while we wait for hi3: the initiator's first sealed frame,
      // delivered ahead of its hi3. Dropping it cost the stream its counter
      // (the next frame failed to decrypt: E2E runs 37784108605, 37900582863).
      if (this.early.length >= MAX_EARLY_FRAMES) return this.fail(step, 'early-frames');
      this.early.push(frame);
      return;
    }
    if (f === undefined) return this.strike(step, 'malformed', now);
    if (f['t'] === 'bye') {
      return this.finish(step, typeof f['why'] === 'string' ? f['why'].slice(0, 64) : 'bye');
    }
    if (this.phase === 'await-hi1' && f['t'] === 'hi1') return this.onHi1(f, now, step);
    if (this.phase === 'await-hi2' && f['t'] === 'hi2') return this.onHi2(f, now, step);
    if (this.phase === 'await-hi3' && f['t'] === 'hi3') return this.onHi3(f, now, step);
    this.strike(step, 'protocol', now);
    this.fail(step, 'protocol');
  }

  private bad(step: Step, now: number, reason: StrikeReason, why: string): void {
    this.strike(step, reason, now);
    this.fail(step, why);
  }

  private onHi1(f: Record<string, unknown>, now: number, step: Step): void {
    if (!hasOnlyKeys(f, ['t', 'v', 'tm', 'e', 'cm']) || f['v'] !== 1 || !isTeamId(f['tm'])) {
      return this.bad(step, now, 'malformed', 'malformed');
    }
    if (f['tm'] !== this.store.teamId) return this.fail(step, 'team');
    const peerEph = fromB64uLen(f['e'], KEY_BYTES);
    if (peerEph === undefined || !isB64uLen(f['cm'], 32)) {
      return this.bad(step, now, 'malformed', 'malformed');
    }
    this.ephSecret = this.c.randomBytes(KEY_BYTES);
    this.shared = safeShared(this.c, this.ephSecret, peerEph);
    if (this.shared === undefined) return this.bad(step, now, 'malformed', 'auth');
    this.hi1 = f as unknown as Json;
    const e = toB64u(this.c.x25519.publicKey(this.ephSecret));
    this.t1 = this.transcript1(this.hi1, e);
    this.ephR = e;
    const id = this.store.id;
    this.t2 = this.transcript(this.t1, 'hs2', { id });
    const inner = {
      id,
      mc: this.identityMac(this.t2, id, 'r'),
      sg: toB64u(this.c.ed25519.sign(this.t2, this.store.keys.signSecret)),
    };
    this.emitClear(step, clear({ t: 'hi2', e, x: this.sealHello('hs-r', this.t1, inner) }));
    this.phase = 'await-hi3';
  }

  private onHi2(f: Record<string, unknown>, now: number, step: Step): void {
    const peerEph = fromB64uLen(f['e'], KEY_BYTES);
    if (!hasOnlyKeys(f, ['t', 'e', 'x']) || peerEph === undefined) {
      return this.bad(step, now, 'malformed', 'malformed');
    }
    this.shared = safeShared(this.c, this.ephSecret!, peerEph);
    if (this.shared === undefined) return this.bad(step, now, 'malformed', 'auth');
    this.t1 = this.transcript1(this.hi1!, f['e'] as string);
    this.ephR = f['e'] as string;
    this.revealed = this.commitNonce;
    const inner = this.openHello('hs-r', this.t1, f['x'], ['id', 'mc', 'sg']);
    if (inner === undefined || !isMemberId(inner['id'])) {
      return this.bad(step, now, 'decrypt', 'auth');
    }
    const peer = inner['id'];
    const t2 = this.transcript(this.t1, 'hs2', { id: peer });
    const sigOk = safeVerify(
      this.c,
      fromB64uLen(inner['sg'], SIG_BYTES),
      t2,
      memberPublicKey(peer),
    );
    if (!sigOk || inner['mc'] !== this.identityMac(t2, peer, 'r')) {
      return this.bad(step, now, 'signature', 'auth');
    }
    // A joiner cannot check membership yet (it has no log); a member can and must.
    const knowsTeam = this.store.state.owner !== undefined;
    if (knowsTeam && !this.store.isActiveMember(peer)) return this.fail(step, 'peer-not-member');
    if (peer === this.store.id) return this.fail(step, 'self');
    const join = this.options.join;
    const myId = join ? join.m : this.store.id;
    const inner3: Record<string, Json> = {
      id: myId,
      mc: this.identityMac(t2, myId, 'i'),
      nn: toB64u(this.commitNonce!),
    };
    if (join) inner3['join'] = join as unknown as Json;
    const t3 = this.transcript(t2, 'hs3', inner3);
    inner3['sg'] = toB64u(this.c.ed25519.sign(t3, this.store.keys.signSecret));
    this.emitClear(step, clear({ t: 'hi3', x: this.sealHello('hs-i', t2, inner3) }));
    this.deriveKeys(t3);
    this.peer = peer;
    this.peerUnverified = !knowsTeam;
    this.open(step, join !== undefined, now);
  }

  private onHi3(f: Record<string, unknown>, now: number, step: Step): void {
    if (!hasOnlyKeys(f, ['t', 'x'])) return this.bad(step, now, 'malformed', 'malformed');
    const inner = this.openHello('hs-i', this.t2!, f['x'], ['id', 'mc', 'nn', 'join', 'sg']);
    if (inner === undefined || !isMemberId(inner['id'])) {
      return this.bad(step, now, 'decrypt', 'auth');
    }
    const peer = inner['id'];
    const unsigned = Object.fromEntries(
      Object.entries(inner).filter(([k]) => k !== 'sg'),
    ) as Record<string, Json>;
    const t3 = this.transcript(this.t2!, 'hs3', unsigned);
    const sigOk = safeVerify(
      this.c,
      fromB64uLen(inner['sg'], SIG_BYTES),
      t3,
      memberPublicKey(peer),
    );
    const nonce = fromB64uLen(inner['nn'], 16);
    this.revealed = nonce;
    const committed = (this.hi1 as Record<string, unknown>)['cm'];
    if (
      !sigOk ||
      inner['mc'] !== this.identityMac(this.t2!, peer, 'i') ||
      nonce === undefined ||
      toB64u(this.commitment(nonce)) !== committed
    ) {
      return this.bad(step, now, 'signature', 'auth');
    }
    if (peer === this.store.id) return this.fail(step, 'self');
    if (inner['join'] !== undefined) {
      const raw = inner['join'];
      const proof =
        isRecord(raw) && hasOnlyKeys(raw, JOIN_PROOF_KEYS) ? parseJoinProof(raw) : undefined;
      if (proof === undefined || proof.m !== peer) {
        return this.bad(step, now, 'malformed', 'malformed');
      }
      if (!this.store.isActiveMember(proof.m)) {
        const res = this.store.admit(proof, now);
        if ('error' in res) return this.fail(step, `join-${res.error}`);
        step.events.push({ type: 'admitted', member: proof.m, op: res.op });
      }
    } else if (!this.store.isActiveMember(peer)) {
      return this.fail(step, 'not-member');
    }
    this.deriveKeys(t3);
    this.peer = peer;
    this.open(step, inner['join'] !== undefined, now);
    // Sealed frames that overtook hi3, now that their keys exist, in order.
    for (const frame of this.early.splice(0)) {
      if (this.phase !== 'open') break;
      this.onSealed(frame, now, step);
    }
  }

  /** T1 binds the hello and the responder's ephemeral key. */
  private transcript1(hi1: Json, e: string): Uint8Array {
    return this.c.sha256(concatBytes(label('hs1'), clear(hi1), utf8(e)));
  }

  private transcript(prev: Uint8Array, name: string, part: Json): Uint8Array {
    return this.c.sha256(concatBytes(label(name), prev, clear(part)));
  }

  private commitment(nonce: Uint8Array): Uint8Array {
    return this.c.sha256(concatBytes(label('commit'), nonce));
  }

  /** Identities travel encrypted under keys only the two ephemeral keys' owners derive. */
  private sealHello(name: string, salt: Uint8Array, inner: Json): string {
    const key = derive(this.c, this.shared!, salt, name);
    return toB64u(this.c.aead.seal(key, new Uint8Array(NONCE_BYTES), clear(inner), salt));
  }

  private openHello(
    name: string,
    salt: Uint8Array,
    x: unknown,
    keys: readonly string[],
  ): Record<string, unknown> | undefined {
    const key = derive(this.c, this.shared!, salt, name);
    const plain = safeOpen(this.c, key, new Uint8Array(NONCE_BYTES), fromB64u(x), salt);
    const inner = plain === undefined ? undefined : parseFrameObject(plain);
    return inner !== undefined && hasOnlyKeys(inner, keys) ? inner : undefined;
  }

  /** SIGMA's identity MAC: proves the signer of this side also holds the DH secret. */
  private identityMac(t2: Uint8Array, id: string, side: 'i' | 'r'): string {
    const key = derive(this.c, this.shared!, t2, `confirm-${side}`);
    return toB64u(this.c.hmacSha256(key, utf8(id)));
  }

  private deriveKeys(t3: Uint8Array): void {
    const shared = this.shared!;
    const i2r = derive(this.c, shared, t3, 'i2r');
    const r2i = derive(this.c, shared, t3, 'r2i');
    [this.sendKey, this.recvKey] = this.side === 'initiator' ? [i2r, r2i] : [r2i, i2r];
    // The code depends only on values fixed before the initiator's nonce is
    // revealed (cm, both ephemerals) plus the nonce itself, not on the rest of
    // hi3, which a man in the middle could vary offline to grind it (re-review #4).
    const hello = this.hi1 as Record<string, unknown>;
    const sasInput = this.c.sha256(
      concatBytes(
        label('sas'),
        fromB64u(hello['cm']) ?? new Uint8Array(0),
        this.revealed ?? new Uint8Array(0),
        fromB64u(hello['e']) ?? new Uint8Array(0),
        fromB64u(this.ephR) ?? new Uint8Array(0),
      ),
    );
    const sas = derive(this.c, shared, sasInput, 'safety', new Uint8Array(0), 4);
    const n = (((sas[0]! << 24) >>> 0) + (sas[1]! << 16) + (sas[2]! << 8) + sas[3]!) % 1_000_000;
    this.safetyCode = n.toString().padStart(6, '0');
    this.ephSecret = undefined;
    this.shared = undefined;
  }

  private open(step: Step, joining: boolean, now: number): void {
    this.phase = 'open';
    step.events.push({ type: 'open', peer: this.peer!, joining });
    if (this.options.signalOnly === true) return;
    this.sendSealed({ t: 'vv', v: this.store.versionVector() }, step);
    if (this.options.logOnly !== true) {
      this.sendOps(this.store.liveEphemeral(now), false, step, LANE_LIVE);
    }
  }

  // ── Open phase ────────────────────────────────────────────────────────────

  private seal(plain: Uint8Array): Uint8Array {
    return this.c.aead.seal(this.sendKey!, counterNonce(this.sendCounter++), plain, FRAME_AAD);
  }

  /** A clear frame (handshake, a refusal before keys): in order, ahead of anything sealed. */
  private emitClear(step: Step, frame: Uint8Array): void {
    if (this.options.pull === true) this.pre.push(frame);
    else step.send.push(frame);
  }

  /** Seal now (default) or queue the plaintext on `lane` until the link takes it (pull mode). */
  private sendSealed(obj: Json, step: Step, lane: Lane = LANE_SYNC, mark?: Outgoing['mark']): void {
    const plain = clear(obj);
    if (this.options.pull === true) {
      const out: Outgoing = mark === undefined ? { plain } : { plain, mark };
      // `upok` is the switch point to mux framing: get it out first.
      if (mark === 'upok') this.outbox[lane]!.unshift(out);
      else this.outbox[lane]!.push(out);
      return;
    }
    step.send.push(this.seal(plain));
  }

  /**
   * The session's last frame (`bye`). Pull mode drops the plaintext still
   * queued (the counter stays contiguous: it was never sealed) and seals the
   * bye now, behind any clear frame not yet taken. Between `up` and `upok`
   * the peer expects mux framing, so no bye is sent at all.
   */
  private sendFinal(obj: Json, step: Step): void {
    if (this.options.pull !== true) {
      step.send.push(this.seal(clear(obj)));
      return;
    }
    this.outbox = [[], [], [], []];
    if (!this.holding) this.pre.push(this.seal(clear(obj)));
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
    if (
      this.options.signalOnly === true &&
      (f['t'] === 'vv' || f['t'] === 'want' || f['t'] === 'ops')
    ) {
      // A signalling session never syncs (the room is no data relay).
      return this.strike(step, 'protocol', now);
    }
    switch (f['t']) {
      case 'vv':
        return this.onVv(f, now, step);
      case 'want':
        return this.onWant(f, now, step);
      case 'ops':
        return this.onOps(f, now, step);
      case 'bye':
        return this.finish(step, typeof f['why'] === 'string' ? f['why'].slice(0, 64) : 'bye');
      case 'up':
        return this.onUp(f, now, step);
      case 'upok':
        return this.onUpOk(f, now, step);
      case 'rtc':
        return this.onRtc(f, now, step);
      default:
        return this.strike(step, 'protocol', now);
    }
  }

  /** Whether this session speaks the LAN upgrade (else `up`/`upok` are unknown frames, as in 2.6). */
  private speaksUpgrade(): boolean {
    return this.options.pull === true && this.options.linkUpgrade === true;
  }

  /** Responder: switch to mux framing; `upok` is our last v1-framed frame. */
  private onUp(f: Record<string, unknown>, now: number, step: Step): void {
    if (!this.speaksUpgrade() || this.side !== 'responder' || this.upgrade !== 'none') {
      return this.strike(step, 'protocol', now);
    }
    if (!hasOnlyKeys(f, ['t'])) return this.strike(step, 'malformed', now);
    this.upgrade = 'done';
    this.upgradeIn = true;
    this.sendSealed({ t: 'upok' }, step, LANE_URGENT, 'upok');
    step.events.push({ type: 'upgrade' });
  }

  /** Initiator: the responder switched; so do we, both ways. */
  private onUpOk(f: Record<string, unknown>, now: number, step: Step): void {
    if (!this.speaksUpgrade() || this.side !== 'initiator' || this.upgrade !== 'sent') {
      return this.strike(step, 'protocol', now);
    }
    if (!hasOnlyKeys(f, ['t'])) return this.strike(step, 'malformed', now);
    this.upgrade = 'done';
    this.holding = false;
    this.upgradeIn = true;
    this.upgradeOut = true;
    step.events.push({ type: 'upgrade' });
  }

  /** WebRTC signalling, only from an authenticated active member (R-RTC-3), rate-limited. */
  private onRtc(f: Record<string, unknown>, now: number, step: Step): void {
    if (this.options.rtc !== true) return this.strike(step, 'protocol', now);
    const signal = parseRtcSignal(f);
    if (signal === undefined) return this.strike(step, 'malformed', now);
    if (this.peerUnverified || !this.store.isActiveMember(this.peer!)) {
      return this.strike(step, 'protocol', now);
    }
    if (!this.rtcBucket.take(1, now)) return this.strike(step, 'rate', now);
    step.events.push({ type: 'rtc', signal });
  }

  private onVv(f: Record<string, unknown>, now: number, step: Step): void {
    const v = f['v'];
    if (!hasOnlyKeys(f, ['t', 'v']) || !isRecord(v) || Object.keys(v).length > 4096) {
      return this.strike(step, 'malformed', now);
    }
    const vv = dict<number>();
    for (const [author, n] of Object.entries(v)) {
      if (!isMemberId(author) || !Number.isSafeInteger(n) || (n as number) < 1) {
        return this.strike(step, 'malformed', now);
      }
      vv[author] = n as number;
    }
    this.peerVv = vv;
    if (this.options.pull === true) {
      // A slow path (relay, paced) can take longer than a tick to serve one
      // `want`: forget only requests that stopped making progress, or the
      // peer serves the same ranges twice and the late copies arrive
      // unsolicited, over-rate, as strikes (found by the simulator).
      for (const a of new Set([...this.outstanding.keys(), ...this.asked.keys()])) {
        if (now - (this.wantProgress.get(a) ?? -Infinity) > WANT_STALE_MS) {
          this.outstanding.delete(a);
          this.asked.delete(a);
        }
      }
    } else {
      this.outstanding.clear();
    }
    this.wantRounds = 0;
    this.requestMissing(step);
  }

  /** Ask for what the peer has and we don't, membership-relevant authors first. */
  private requestMissing(step: Step): void {
    if (this.peerVv === undefined) return;
    const mine = this.store.versionVector();
    // Pull mode: one request in flight per author (the next slice follows when
    // it is in); a second one would overlap it, and its late copies would
    // arrive unsolicited. Without pull mode, as in 2.6: re-ask past the head.
    const pull = this.options.pull === true;
    const missing = missingRanges(mine, this.peerVv).filter(([a, , to]) =>
      pull ? !this.outstanding.has(a) : (this.outstanding.get(a) ?? 0) < to,
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
    for (const [a, , to] of ranges) {
      this.outstanding.set(a, to);
      this.wantProgress.set(a, this.clock);
      if (pull) this.asked.set(a, Math.max(this.asked.get(a) ?? 0, to));
    }
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
      for (const op of this.store.opsInRange(a, from as number, to as number)) out.push(op);
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
    /** Highest seq the peer served per author in this frame. */
    const served = new Map<string, number>();
    let overRate = false;
    for (const raw of o as unknown[]) {
      const env = isRecord(raw) ? raw : undefined;
      const author = env?.['au'];
      const sq = env?.['sq'];
      // Only logged ops (seq ≥ 1) can answer a `want`: an ephemeral op (seq 0)
      // in a solicited frame is unsolicited and pays its rate like any other.
      const asked =
        solicited &&
        typeof author === 'string' &&
        typeof sq === 'number' &&
        sq >= 1 &&
        sq <= Math.max(this.outstanding.get(author) ?? 0, this.asked.get(author) ?? 0);
      const category = categoryOf(String(env?.['t'] ?? ''));
      if (!asked && !this.admit(category, author, now)) {
        // An over-rate live stroke is dropped without a strike: each one holds the
        // whole stroke so far (the next heals it), and three teammates drawing at
        // once must not get a relaying phone banned. Frames and bytes still strike.
        if (category !== 'draw') overRate = true;
        continue;
      }
      if (asked) {
        served.set(author as string, Math.max(served.get(author as string) ?? 0, sq as number));
        this.wantProgress.set(author as string, now);
      }
      admitted.push(raw);
    }
    if (overRate) this.strike(step, 'rate', now);
    if (admitted.length > 0) {
      const report = this.store.ingest(admitted, now);
      step.events.push({ type: 'ingested', report });
      const forged = report.rejected.filter((x) => x.reason === 'signature').length;
      const junk = report.rejected.filter((x) =>
        [
          'not-object',
          'unknown-field',
          'version',
          'shape',
          'too-large',
          'type',
          'author',
          'chain',
        ].includes(x.reason),
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
      for (const [a, to] of [...this.outstanding]) {
        // Done when we hold it, or when the peer served it all and our chain still
        // falls short (an anchored chain re-pinning: ask again from our new head).
        if ((vv[a] ?? 0) >= to || (served.get(a) ?? 0) >= to) this.outstanding.delete(a);
      }
      for (const [a, n] of served) if (n >= (this.asked.get(a) ?? 0)) this.asked.delete(a);
      // Ask for the next slice once this round is in (a peer that sends nothing stalls only itself).
      if (this.outstanding.size === 0 && this.wantRounds < MAX_WANT_ROUNDS) {
        this.wantRounds++;
        this.requestMissing(step);
      }
    }
  }

  /**
   * Rate check for one unsolicited op. Live strokes are metered per author
   * (a member's own bucket; anyone not an active member shares one), so one
   * noisy drawer cannot starve the others on this link (#683).
   */
  private admit(category: OpCategory, author: unknown, now: number): boolean {
    if (category !== 'draw') return this.guard.admitOp(category, now);
    const key = typeof author === 'string' && this.store.isActiveMember(author) ? author : '';
    return this.guard.admitDraw(key, now);
  }

  /**
   * A gated op goes only over a transport allowed to carry it
   * ({@link SessionOptions.carryLiveStrokes}, off by default), only to a peer
   * with a current claim, and never to one muted for this team.
   */
  private mayCarry(op: SignedOp): boolean {
    const cap = own(GATED_TYPES, op.env.t);
    if (cap === undefined) return true;
    if (this.options.carryLiveStrokes !== true || this.peer === undefined) return false;
    if (this.options.liveStrokeMute?.has(this.peer) === true) return false;
    return this.store.canReceive?.(this.peer, cap, this.clock) === true;
  }

  private sendOps(
    all: readonly SignedOp[],
    solicited: boolean,
    step: Step,
    lane: Lane = LANE_SYNC,
  ): void {
    const ops = all.filter((op) => this.mayCarry(op));
    if (ops.some((op) => own(GATED_TYPES, op.env.t) !== undefined)) this.lastPenAt = this.clock;
    const budget = this.guard.limits.maxFrameBytes - FRAME_OVERHEAD;
    let batch: Json[] = [];
    let size = 0;
    const flush = () => {
      if (batch.length === 0) return;
      const frame: Record<string, Json> = { t: 'ops', o: batch };
      if (solicited) frame['re'] = 1;
      this.sendSealed(frame, step, lane);
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
    if (this.phase === 'open') this.sendFinal({ t: 'bye', why }, step);
    else this.emitClear(step, clear({ t: 'bye', why }));
    this.finish(step, why);
  }

  private finish(step: Step, why: string): void {
    const pen = this.lastPenAt;
    if (pen !== undefined && this.peer !== undefined && this.clock - pen <= PEN_IN_FLIGHT_MS) {
      this.options.liveStrokeMute?.add(this.peer);
    }
    this.phase = 'closed';
    this.sendKey = undefined;
    this.recvKey = undefined;
    this.early = [];
    step.events.push({ type: 'closed', why });
  }
}
