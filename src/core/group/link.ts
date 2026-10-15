import {
  bytesEqual,
  concatBytes,
  fromB64u,
  fromB64uLen,
  toB64u,
  toHex,
  utf8,
  utf8Decode,
} from '../team/bytes';
import { canonicalize, hasOnlyKeys, isRecord, parseJson } from '../team/canonical';
import { derive, label, type TeamCrypto } from '../team/crypto';
import {
  LAN_LIMITS,
  PeerGuard,
  RELAY_LIMITS,
  TokenBucket,
  type PeerLimits,
  type StrikeReason,
} from '../team/ratelimit';
import type { SessionEvent } from '../team/sync';
import { LANE_URGENT, LaneScheduler, LANES, type Lane } from './lanes';
import type { PathKind } from './path';

/**
 * The link layer (2.7.0 design §2.2 and §2.6, #705): one authenticated
 * connection to one remote phone, carrying many sync groups as channels,
 * served by priority lanes, every frame padded to a size bucket.
 *
 * ```
 * carrier frame = u8 ver=1 | u8 kind | u16 channel | u32 length | payload | zero padding
 * kind: 0 lk1 hello · 1 ch-open · 2 ch-ok · 3 ch-no · 4 data · 5 ch-close · 6 pad/keepalive
 * ```
 *
 * - **Hello (`lk1`)**: `{v, caps[], n}` (canonical JSON) from both sides; the
 *   link id is `H("lnk" ‖ nonceInitiator ‖ nonceResponder)`. A peer that
 *   speaks a higher version is answered at the highest common one; below 1
 *   the link closes without a strike (as the mesh preamble does).
 * - **Channel open**: `cls ‖ tag`, `tag = HMAC(HKDF(groupId, "chan"), linkId ‖ cls)`.
 *   The responder answers `ch-ok` only for a group it holds (and its
 *   factory accepts), `ch-no` otherwise, with no reason: a peer learns
 *   nothing about groups whose id it does not already know. The initiator
 *   of the link uses even channel numbers, the responder odd ones; 0 is the
 *   legacy LAN channel (a 2.6-framed session upgraded in place).
 * - **Identity**: every channel runs a full SyncSession v1; its authenticated
 *   peer must equal the link's identity (from L0 on the internet, from the
 *   first channel on the LAN), or the link closes.
 * - **Bans** (review R-RL-4): an internet link is banned by member id, never
 *   by IP (CGNAT shares addresses); {@link MemberBans} is shared by every link.
 * - **Padding** (review R-META-3): every carrier frame is padded to 256 B,
 *   1, 4 or 16 KiB (then whole 16 KiB steps), capped at the carrier's limit.
 *
 * Pure and total: nothing a peer sends makes it throw; the platform carrier
 * moves the bytes and calls {@link LinkMux.receive}, and pulls frames with
 * {@link LinkMux.next} while the carrier is writable (shallow native queues,
 * design §4.4: lane 0 must never wait behind megabytes handed to native code).
 */

// ── Carrier interface (design §2.2) ─────────────────────────────────────────

export type SendResult = 'ok' | 'backpressure' | 'closed';

export interface CarrierConn {
  /** One connection; a reconnect is a new id (as `MeshPeer.peerId`). */
  readonly connId: string;
  readonly path: PathKind;
  /** LAN 512 KiB, WebRTC 64 KiB per message, room 16 KiB. */
  readonly maxFrameBytes: number;
  /** `backpressure`: wait for a `writable` event before sending more. */
  send(frame: Uint8Array, lane: Lane): SendResult;
  close(why: string): void;
  /** Nearby only (IP ban); internet bans are by member id ({@link MemberBans}). */
  ban?(ms: number): void;
}

export type CarrierEvent =
  | { type: 'conn'; conn: CarrierConn; direction: 'in' | 'out'; hint?: { groupHint?: string } }
  | { type: 'frame'; connId: string; data: Uint8Array }
  | { type: 'writable'; connId: string }
  | { type: 'closed'; connId: string; reason: string }
  | { type: 'state'; online: boolean; detail: Record<string, unknown> };

export interface Carrier {
  readonly kind: 'mesh' | 'rtc' | 'room';
  subscribe(l: (e: CarrierEvent) => void): () => void;
}

// ── Wire format ──────────────────────────────────────────────────────────────

export const LINK_VERSION = 1;
export const MUX_HEADER_BYTES = 8;
export const FRAME_KIND = {
  hello: 0,
  open: 1,
  ok: 2,
  no: 3,
  data: 4,
  close: 5,
  pad: 6,
} as const;
export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND];

/** Padding buckets (review R-META-3); above the last, whole multiples of it. */
export const PAD_BUCKETS: readonly number[] = [256, 1024, 4096, 16384];
export const MAX_CHANNELS = 64;
export const MAX_CHANNEL_ID = 0xffff;
export const MAX_HELLO_BYTES = 1024;
export const MAX_CAPS = 16;
export const MAX_CAP_LENGTH = 16;
export const NONCE_LENGTH = 16;
export const TAG_LENGTH = 32;
/** `ch-no` replies a peer may cause per minute before each further one is a strike (probing). */
export const MAX_REFUSALS_PER_MIN = 10;
/** Channel opens a peer may ask for: [per second, burst]. */
export const CHANNEL_OPEN_RATE: [number, number] = [2, 16];
/** Idle this long → a keepalive (design §2.5: two misses fail a path). */
export const KEEPALIVE_MS = 15_000;
/** Both hellos must be exchanged within this long. */
export const HELLO_TIMEOUT_MS = 30_000;
/**
 * Share of the peer's admitted rate (its {@link PeerGuard} limits, the same
 * constants on both phones) a sender uses: the rest absorbs arrivals bunched
 * up behind a retransmission. A frame the peer's guard refuses is dropped,
 * and a dropped frame ends an AEAD counter stream, so honest phones must
 * never be refused.
 */
export const PACE_SHARE = 0.5;
/** Frames of headroom lanes 1–3 leave to lane 0 and control frames: an SOS never waits on pacing. */
export const URGENT_RESERVE_FRAMES = 2;

/**
 * Send-side pacing that mirrors the receiver's guard (bytes and frames per
 * second, with bursts), at {@link PACE_SHARE} of it.
 */
export class Pacer {
  private bytes: number;
  private frames: number;
  private last: number;
  private readonly capBytes: number;
  private readonly capFrames: number;

  constructor(
    private readonly limits: PeerLimits,
    now: number,
    readonly share = PACE_SHARE,
  ) {
    this.capBytes = limits.burstBytes * share;
    this.capFrames = limits.burstFrames * share;
    this.bytes = this.capBytes;
    this.frames = this.capFrames;
    this.last = now;
  }

  private refill(now: number): void {
    if (now > this.last) {
      const dt = (now - this.last) / 1000;
      this.bytes = Math.min(this.capBytes, this.bytes + dt * this.limits.bytesPerSec * this.share);
      this.frames = Math.min(
        this.capFrames,
        this.frames + dt * this.limits.framesPerSec * this.share,
      );
      this.last = now;
    }
  }

  private need(size: number, reserveFrames: number): [number, number] {
    return [
      Math.min(this.capBytes, size * (1 + reserveFrames)),
      Math.min(this.capFrames, 1 + reserveFrames),
    ];
  }

  /** Whether a frame of up to `size` bytes may leave now, keeping `reserveFrames` frames' worth back. */
  allows(size: number, now: number, reserveFrames = 0): boolean {
    this.refill(now);
    const [b, f] = this.need(size, reserveFrames);
    return this.bytes >= b && this.frames >= f;
  }

  spend(size: number, now: number): void {
    this.refill(now);
    this.bytes -= size;
    this.frames -= 1;
  }

  /** Milliseconds until {@link allows} would say yes. */
  waitMs(size: number, now: number, reserveFrames = 0): number {
    this.refill(now);
    const [b, f] = this.need(size, reserveFrames);
    const byBytes = ((b - this.bytes) / (this.limits.bytesPerSec * this.share)) * 1000;
    const byFrames = ((f - this.frames) / (this.limits.framesPerSec * this.share)) * 1000;
    return Math.max(0, Math.ceil(byBytes), Math.ceil(byFrames));
  }
}
/** Closed channel ids whose late frames are ignored (not struck). */
const RECENTLY_CLOSED = 64;

export type ChannelClass = 'sync' | 'blob';
const CLASS_BYTE: Readonly<Record<ChannelClass, number>> = { sync: 0, blob: 1 };

/** The carrier frame size for a payload of `n` bytes, or `undefined` above `max`. */
export function paddedSize(n: number, max: number): number | undefined {
  const need = n + MUX_HEADER_BYTES;
  if (need > max) return undefined;
  const bucket = PAD_BUCKETS.find((b) => b >= need);
  const last = PAD_BUCKETS[PAD_BUCKETS.length - 1]!;
  const size = bucket ?? Math.ceil(need / last) * last;
  return Math.min(size, max);
}

export interface MuxFrame {
  kind: FrameKind;
  ch: number;
  payload: Uint8Array;
}

/** Encode and pad one mux frame; `undefined` when it cannot fit `max`. */
export function encodeMuxFrame(
  kind: FrameKind,
  ch: number,
  payload: Uint8Array,
  max: number,
): Uint8Array | undefined {
  if (!Number.isInteger(ch) || ch < 0 || ch > MAX_CHANNEL_ID) return undefined;
  const size = paddedSize(payload.length, max);
  if (size === undefined) return undefined;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint8(0, LINK_VERSION);
  view.setUint8(1, kind);
  view.setUint16(2, ch);
  view.setUint32(4, payload.length);
  out.set(payload, MUX_HEADER_BYTES);
  return out;
}

/** Total parse of one carrier frame: version, kind, length and all-zero padding. */
export function decodeMuxFrame(bytes: Uint8Array): MuxFrame | undefined {
  if (bytes.length < MUX_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== LINK_VERSION) return undefined;
  const kind = view.getUint8(1);
  if (kind > FRAME_KIND.pad) return undefined;
  const ch = view.getUint16(2);
  const len = view.getUint32(4);
  if (len > bytes.length - MUX_HEADER_BYTES) return undefined;
  for (let i = MUX_HEADER_BYTES + len; i < bytes.length; i++) if (bytes[i] !== 0) return undefined;
  return {
    kind: kind as FrameKind,
    ch,
    payload: bytes.slice(MUX_HEADER_BYTES, MUX_HEADER_BYTES + len),
  };
}

export interface LinkHello {
  v: number;
  caps: string[];
  n: Uint8Array;
}

export function encodeHello(h: LinkHello): Uint8Array {
  return utf8(canonicalize({ v: h.v, caps: h.caps, n: toB64u(h.n) })!);
}

/** Total parse of a hello payload; `v` is any positive integer (negotiated down). */
export function decodeHello(payload: Uint8Array): LinkHello | 'version' | undefined {
  if (payload.length > MAX_HELLO_BYTES) return undefined;
  const text = utf8Decode(payload);
  const value = text === undefined ? undefined : parseJson(text);
  if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'caps', 'n'])) return undefined;
  const v = value['v'];
  if (!Number.isSafeInteger(v)) return undefined;
  if ((v as number) < 1) return 'version';
  const caps = value['caps'];
  if (!Array.isArray(caps) || caps.length > MAX_CAPS) return undefined;
  for (const cap of caps) {
    if (typeof cap !== 'string' || cap.length === 0 || cap.length > MAX_CAP_LENGTH)
      return undefined;
  }
  const n = fromB64uLen(value['n'], NONCE_LENGTH);
  if (n === undefined) return undefined;
  return { v: v as number, caps: caps as string[], n };
}

/** `H("lnk" ‖ nonceInitiator ‖ nonceResponder)`. */
export function linkIdOf(
  c: TeamCrypto,
  initiatorNonce: Uint8Array,
  responderNonce: Uint8Array,
): Uint8Array {
  return c.sha256(concatBytes(label('lnk'), initiatorNonce, responderNonce));
}

/** `HMAC(HKDF(groupId, "chan"), linkId ‖ cls)`: binds a channel open to this link and group. */
export function channelTag(
  c: TeamCrypto,
  groupId: string,
  linkId: Uint8Array,
  cls: ChannelClass,
): Uint8Array {
  const ikm = fromB64u(groupId) ?? utf8(groupId);
  const key = derive(c, ikm, new Uint8Array(0), 'chan');
  return c.hmacSha256(key, concatBytes(linkId, Uint8Array.of(CLASS_BYTE[cls])));
}

/** Session limits per path (review R-RL-4): internet paths use the relay budgets. */
export function limitsForPath(path: PathKind): PeerLimits {
  return path === 'nearby' ? LAN_LIMITS : RELAY_LIMITS;
}

/**
 * Limits for a session inside a channel: its frames must fit the carrier
 * with the mux header (the session sizes its own `ops` batches from this).
 */
export function channelLimits(base: PeerLimits, carrierMaxBytes: number): PeerLimits {
  return {
    ...base,
    maxFrameBytes: Math.min(base.maxFrameBytes, carrierMaxBytes - MUX_HEADER_BYTES),
  };
}

// ── Bans by member id (review R-RL-4) ───────────────────────────────────────

export const MAX_BANS = 4096;

/**
 * Internet bans, keyed by member id (or a session key for a peer not yet
 * authenticated), never by IP: CGNAT puts many phones behind one address.
 * Bounded: past {@link MAX_BANS} the ban ending soonest is dropped.
 */
export class MemberBans {
  private readonly until = new Map<string, number>();

  ban(member: string, until: number): void {
    const prev = this.until.get(member);
    this.until.set(member, Math.max(prev ?? 0, until));
    if (this.until.size > MAX_BANS) {
      let soonest: string | undefined;
      let at = Infinity;
      for (const [m, t] of this.until) {
        if (t < at) {
          at = t;
          soonest = m;
        }
      }
      if (soonest !== undefined) this.until.delete(soonest);
    }
  }

  isBanned(member: string, now: number): boolean {
    const t = this.until.get(member);
    if (t === undefined) return false;
    if (now >= t) {
      this.until.delete(member);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.until.size;
  }
}

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * What runs inside a channel. `SyncSession` in pull mode satisfies it (the
 * blob engine will too): frames wait inside as plaintext and are sealed when
 * the link takes them, so lanes decide what leaves next.
 */
export interface MuxChannel {
  readonly phase: string;
  readonly peer: string | undefined;
  readonly bannedUntil: number | undefined;
  receive(data: Uint8Array, now: number): { events: SessionEvent[] };
  tick(now: number): { events: SessionEvent[] };
  close(why?: string): { events: SessionEvent[] };
  hasPending(lane: Lane): boolean;
  nextFrame(lane: Lane): Uint8Array | undefined;
  /** Legacy LAN channel only: the switch points of the v1 → mux upgrade. */
  readonly upgradeIn?: boolean;
  readonly upgradeOut?: boolean;
}

export interface ChannelRequest {
  groupId: string;
  cls: ChannelClass;
  /** `initiator`: we asked for this channel and the peer accepted. */
  side: 'initiator' | 'responder';
  now: number;
}

export type LinkEvent =
  | { type: 'ready'; linkId: string; caps: string[] }
  | {
      type: 'channel';
      ch: number;
      groupId: string;
      cls: ChannelClass;
      side: 'initiator' | 'responder';
    }
  | { type: 'refused'; groupId: string; cls: ChannelClass }
  | { type: 'session'; ch: number; groupId: string; event: SessionEvent }
  | { type: 'channel-closed'; ch: number; groupId: string; why: string }
  | { type: 'identity'; member: string }
  | { type: 'framing'; framing: 'mux' }
  | { type: 'strike'; reason: StrikeReason | 'probing' }
  | { type: 'banned'; member: string; until: number }
  | { type: 'closed'; why: string };

export interface LinkOptions {
  /** `initiator`: we dialled (or hold the lower handle); decides channel parity and link id order. */
  side: 'initiator' | 'responder';
  /** The carrier's frame limit (padding never exceeds it). */
  maxFrameBytes: number;
  /** Flood limits for the link itself (frames, bytes, strikes): {@link limitsForPath}. */
  limits: PeerLimits;
  /** Capabilities this phone offers in its hello. */
  caps?: readonly string[];
  /** Group ids this phone holds (checked for every `ch-open`). */
  groups(): readonly string[];
  /** Build the channel for an accepted open; `undefined` refuses it (`ch-no`). */
  channelFactory(req: ChannelRequest): MuxChannel | undefined;
  /** The peer's member id when another layer already authenticated it (L0 room session). */
  identity?: string;
  /** Shared internet ban list (R-RL-4). */
  bans?: MemberBans;
  /**
   * A LAN connection that started in 2.6 framing: its session (pull mode) is
   * channel 0, and frames stay raw until it upgrades (`up`/`upok`).
   */
  legacy?: { groupId: string; channel: MuxChannel };
  now: number;
  /** Anti-starvation quantum for lanes 2–3 (default 16). */
  quantum?: number;
}

interface ChannelEntry {
  ch: number;
  groupId: string;
  cls: ChannelClass;
  channel: MuxChannel;
  closing: boolean;
}

/** One link to one remote phone: hellos, channels, lanes, padding, bans. */
export class LinkMux {
  state: 'hello' | 'open' | 'closed' = 'hello';
  /** Hex link id once both hellos are in. */
  linkId: string | undefined;
  /** The authenticated remote member id. */
  identity: string | undefined;
  /** Capabilities both sides offered. */
  caps: string[] = [];
  lastHeard: number;
  lastSent: number;
  /** Carrier frames handed out, by lane (control frames count as lane 0). */
  readonly sentByLane = [0, 0, 0, 0];

  /** Framing of what we receive / send: raw v1 until a legacy LAN link upgrades. */
  private inFraming: 'v1' | 'mux';
  private outFraming: 'v1' | 'mux';
  private readonly guard: PeerGuard;
  private readonly scheduler: LaneScheduler;
  private readonly openBucket: TokenBucket;
  private readonly pacer: Pacer;
  private readonly myNonce: Uint8Array;
  private peerNonce: Uint8Array | undefined;
  private helloSentAt: number | undefined;
  private linkIdBytes: Uint8Array | undefined;
  private readonly channels = new Map<number, ChannelEntry>();
  /** Channel opens we asked for, waiting for `ch-ok`/`ch-no`. */
  private readonly opening = new Map<number, { groupId: string; cls: ChannelClass }>();
  /** Opens asked before the hellos were in. */
  private deferred: { groupId: string; cls: ChannelClass }[] = [];
  private nextCh: number;
  private readonly control: Uint8Array[] = [];
  private readonly recentlyClosed: number[] = [];
  private refusals: number[] = [];
  private readonly events: LinkEvent[] = [];
  /** Round-robin position per lane. */
  private readonly cursor = [0, 0, 0, 0];
  /** A legacy link is its one session: it ends with it. */
  private endWithLegacy: boolean;

  constructor(
    private readonly c: TeamCrypto,
    private readonly options: LinkOptions,
  ) {
    this.guard = new PeerGuard(options.limits);
    this.scheduler = new LaneScheduler(options.quantum);
    this.openBucket = new TokenBucket(...CHANNEL_OPEN_RATE);
    this.pacer = new Pacer(options.limits, options.now);
    this.myNonce = c.randomBytes(NONCE_LENGTH);
    this.nextCh = options.side === 'initiator' ? 2 : 1;
    this.lastHeard = options.now;
    this.lastSent = options.now;
    this.identity = options.identity;
    this.endWithLegacy = options.legacy !== undefined;
    if (options.legacy !== undefined) {
      this.inFraming = 'v1';
      this.outFraming = 'v1';
      this.channels.set(0, {
        ch: 0,
        groupId: options.legacy.groupId,
        cls: 'sync',
        channel: options.legacy.channel,
        closing: false,
      });
    } else {
      this.inFraming = 'mux';
      this.outFraming = 'mux';
      this.sendHello(options.now);
    }
    if (this.identity !== undefined) this.checkBanned(this.identity, options.now);
  }

  /** `v1` until both directions use mux framing. */
  get framing(): 'v1' | 'mux' {
    return this.inFraming === 'mux' && this.outFraming === 'mux' ? 'mux' : 'v1';
  }

  get channelCount(): number {
    return this.channels.size;
  }

  /** Every event since the last call (also returned by {@link receive} and {@link tick}). */
  takeEvents(): LinkEvent[] {
    return this.events.splice(0);
  }

  /** Ask the peer for a channel of `groupId` (queued until the hellos are in). */
  open(groupId: string, cls: ChannelClass = 'sync'): void {
    if (this.state === 'closed') return;
    if (this.state !== 'open') {
      this.deferred.push({ groupId, cls });
      return;
    }
    if (this.channelOf(groupId, cls) !== undefined) return;
    for (const o of this.opening.values()) if (o.groupId === groupId && o.cls === cls) return;
    if (this.channels.size + this.opening.size >= MAX_CHANNELS) return;
    const ch = this.allocate();
    this.opening.set(ch, { groupId, cls });
    const tag = channelTag(this.c, groupId, this.linkIdBytes!, cls);
    this.queueControl(FRAME_KIND.open, ch, concatBytes(Uint8Array.of(CLASS_BYTE[cls]), tag));
  }

  /** The channel number carrying `groupId`, if one is open. */
  channelOf(groupId: string, cls: ChannelClass = 'sync'): number | undefined {
    for (const e of this.channels.values()) {
      if (e.groupId === groupId && e.cls === cls && !e.closing) return e.ch;
    }
    return undefined;
  }

  /** Handle one carrier frame. Total: never throws. */
  receive(frame: Uint8Array, now: number): LinkEvent[] {
    if (this.state === 'closed') return this.takeEvents();
    try {
      if (this.inFraming === 'v1') this.receiveLegacy(frame, now);
      else this.receiveMux(frame, now);
    } catch {
      this.strike('protocol', now);
    }
    return this.takeEvents();
  }

  /** Whether {@link next} has a frame to give. */
  hasPending(): boolean {
    if (this.state === 'closed') return false;
    return this.control.length > 0 || LANES.some((l) => this.lanePending(l));
  }

  /**
   * The next carrier frame: control frames first, then lane 0 … 3 (strict
   * priority with the anti-starvation quantum), round-robin across channels
   * within a lane. The channel's session seals it only now.
   */
  next(now: number): Uint8Array | undefined {
    for (let attempt = 0; attempt < 4 && this.state !== 'closed'; attempt++) {
      const ctl = this.control[0];
      if (ctl !== undefined) {
        if (!this.pacer.allows(ctl.length, now)) return undefined;
        this.control.shift();
        return this.sent(ctl, LANE_URGENT, now);
      }
      const lane = this.scheduler.pick((l) => this.lanePending(l));
      if (lane === undefined) break;
      // Sealing is final (the counter advances), so check the worst case first.
      if (!this.pacer.allows(this.options.maxFrameBytes, now, this.reserveFor(lane))) {
        return undefined;
      }
      const out = this.takeFrom(lane);
      this.scheduler.served(lane, (l) => this.lanePending(l));
      if (out !== undefined) return this.sent(out, lane, now);
    }
    this.reap();
    return undefined;
  }

  /**
   * When {@link next} may give a frame again: 0 = now, `undefined` = nothing
   * pending. The carrier's owner sets a timer for it (pacing, see {@link Pacer}).
   */
  nextSendDelay(now: number): number | undefined {
    if (this.state === 'closed') return undefined;
    const ctl = this.control[0];
    if (ctl !== undefined) return this.pacer.waitMs(ctl.length, now);
    const lane = this.scheduler.pick((l) => this.lanePending(l));
    if (lane === undefined) return undefined;
    return this.pacer.waitMs(this.options.maxFrameBytes, now, this.reserveFor(lane));
  }

  private reserveFor(lane: Lane): number {
    return lane === LANE_URGENT ? 0 : URGENT_RESERVE_FRAMES;
  }

  /** Frames up to `budgetBytes` (the carrier's shallow native queue). */
  drain(now: number, budgetBytes = 64 * 1024): Uint8Array[] {
    const out: Uint8Array[] = [];
    let bytes = 0;
    while (bytes < budgetBytes) {
      const f = this.next(now);
      if (f === undefined) break;
      out.push(f);
      bytes += f.length;
    }
    return out;
  }

  /** Periodic: channel ticks, a keepalive when idle, the hello timeout. */
  tick(now: number): LinkEvent[] {
    if (this.state === 'closed') return this.takeEvents();
    if (
      this.state === 'hello' &&
      this.helloSentAt !== undefined &&
      now - this.helloSentAt > HELLO_TIMEOUT_MS
    ) {
      this.closeLink('timeout');
      return this.takeEvents();
    }
    for (const e of [...this.channels.values()]) {
      if (e.closing || this.isClosed()) continue;
      this.channelEvents(e, e.channel.tick(now).events, now);
    }
    if (
      this.state === 'open' &&
      this.framing === 'mux' &&
      now - this.lastSent >= KEEPALIVE_MS &&
      !this.hasPending()
    ) {
      this.queueControl(FRAME_KIND.pad, 0, new Uint8Array(0));
    }
    this.reap();
    return this.takeEvents();
  }

  /** Close every channel and the link; returns the last frames to send (byes, `ch-close`s). */
  close(why: string, now: number): Uint8Array[] {
    if (this.state === 'closed') return [];
    const out: Uint8Array[] = [];
    for (const e of this.channels.values()) {
      if (!e.closing) e.channel.close(why);
      for (
        let f = e.channel.nextFrame(LANE_URGENT);
        f !== undefined;
        f = e.channel.nextFrame(LANE_URGENT)
      ) {
        const wrapped = this.wrap(FRAME_KIND.data, e.ch, f);
        if (wrapped !== undefined) out.push(wrapped);
      }
      if (this.outFraming === 'mux') {
        const bye = encodeMuxFrame(
          FRAME_KIND.close,
          e.ch,
          new Uint8Array(0),
          this.options.maxFrameBytes,
        );
        if (bye !== undefined) out.push(bye);
      }
    }
    if (out.length > 0) this.lastSent = now;
    this.closeLink(why);
    return out;
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  private receiveLegacy(frame: Uint8Array, now: number): void {
    const e = this.channels.get(0);
    if (e === undefined || e.closing) return;
    this.lastHeard = now;
    this.channelEvents(e, e.channel.receive(frame, now).events, now);
    this.syncFraming(now);
  }

  private receiveMux(frame: Uint8Array, now: number): void {
    const admit = this.guard.admitFrame(frame.length, now);
    if (admit !== 'ok') return this.strike(admit, now);
    const f = decodeMuxFrame(frame);
    if (f === undefined) return this.strike('malformed', now);
    this.lastHeard = now;
    if (f.kind === FRAME_KIND.hello) return this.onHello(f, now);
    if (this.peerNonce === undefined) return this.strike('protocol', now);
    switch (f.kind) {
      case FRAME_KIND.pad:
        return;
      case FRAME_KIND.open:
        return this.onOpen(f, now);
      case FRAME_KIND.ok:
      case FRAME_KIND.no:
        return this.onAnswer(f, now);
      case FRAME_KIND.data:
        return this.onData(f, now);
      default:
        return this.onClose(f);
    }
  }

  private onHello(f: MuxFrame, now: number): void {
    if (this.peerNonce !== undefined || f.ch !== 0) return this.strike('protocol', now);
    const hello = decodeHello(f.payload);
    if (hello === 'version') return this.closeLink('version');
    if (hello === undefined) return this.strike('malformed', now);
    // Highest common version: this phone speaks 1, and the peer at least 1.
    this.peerNonce = hello.n;
    const mine = new Set(this.options.caps ?? []);
    this.caps = [...new Set(hello.caps)].filter((cap) => mine.has(cap)).sort();
    this.becomeReady();
  }

  private onOpen(f: MuxFrame, now: number): void {
    const theirs = this.options.side === 'initiator' ? 1 : 0;
    if (
      f.ch === 0 ||
      f.ch % 2 !== theirs ||
      this.channels.has(f.ch) ||
      f.payload.length !== 1 + TAG_LENGTH ||
      (f.payload[0] !== 0 && f.payload[0] !== 1)
    ) {
      return this.strike('protocol', now);
    }
    if (this.state !== 'open') return this.strike('protocol', now);
    if (!this.openBucket.take(1, now)) {
      this.strike('rate', now);
      return this.refuse(f.ch, now);
    }
    if (this.channels.size + this.opening.size >= MAX_CHANNELS) return this.refuse(f.ch, now);
    const cls: ChannelClass = f.payload[0] === 0 ? 'sync' : 'blob';
    const tag = f.payload.slice(1);
    const groupId = this.options
      .groups()
      .find((g) => bytesEqual(channelTag(this.c, g, this.linkIdBytes!, cls), tag));
    if (groupId === undefined || this.channelOf(groupId, cls) !== undefined) {
      return this.refuse(f.ch, now);
    }
    const channel = this.options.channelFactory({ groupId, cls, side: 'responder', now });
    if (channel === undefined) return this.refuse(f.ch, now);
    this.channels.set(f.ch, { ch: f.ch, groupId, cls, channel, closing: false });
    this.queueControl(FRAME_KIND.ok, f.ch, new Uint8Array(0));
    this.events.push({ type: 'channel', ch: f.ch, groupId, cls, side: 'responder' });
  }

  /** `ch-no`, without a reason. Past ten a minute, each one is a strike (probing). */
  private refuse(ch: number, now: number): void {
    this.refusals = this.refusals.filter((t) => now - t < 60_000);
    this.refusals.push(now);
    this.queueControl(FRAME_KIND.no, ch, new Uint8Array(0));
    if (this.refusals.length > MAX_REFUSALS_PER_MIN) this.strike('probing', now);
  }

  private onAnswer(f: MuxFrame, now: number): void {
    const pending = this.opening.get(f.ch);
    if (pending === undefined || f.payload.length !== 0) return this.strike('protocol', now);
    this.opening.delete(f.ch);
    if (f.kind === FRAME_KIND.no) {
      this.events.push({ type: 'refused', ...pending });
      return;
    }
    const channel = this.options.channelFactory({ ...pending, side: 'initiator', now });
    if (channel === undefined) {
      this.queueControl(FRAME_KIND.close, f.ch, new Uint8Array(0));
      this.forget(f.ch);
      return;
    }
    this.channels.set(f.ch, { ch: f.ch, ...pending, channel, closing: false });
    this.events.push({ type: 'channel', ch: f.ch, ...pending, side: 'initiator' });
  }

  private onData(f: MuxFrame, now: number): void {
    const e = this.channels.get(f.ch);
    if (e === undefined) {
      // A frame in flight when we closed the channel is not the peer's fault.
      if (this.recentlyClosed.includes(f.ch)) return;
      return this.strike('protocol', now);
    }
    if (e.closing) return;
    this.channelEvents(e, e.channel.receive(f.payload, now).events, now);
  }

  private onClose(f: MuxFrame): void {
    const e = this.channels.get(f.ch);
    if (e === undefined) {
      this.opening.delete(f.ch);
      return;
    }
    if (!e.closing) {
      e.channel.close('peer-closed');
      this.events.push({
        type: 'channel-closed',
        ch: e.ch,
        groupId: e.groupId,
        why: 'peer-closed',
      });
    }
    this.forget(e.ch);
    if (e.ch === 0 && this.endWithLegacy) this.closeLink('session-closed');
  }

  /** Session events: identity binding, bans, channel endings. */
  private channelEvents(e: ChannelEntry, events: readonly SessionEvent[], now: number): void {
    for (const event of events) {
      if (this.state === 'closed') return;
      this.events.push({ type: 'session', ch: e.ch, groupId: e.groupId, event });
      if (event.type === 'open') this.bindIdentity(event.peer, now);
      if (event.type !== 'closed' || e.closing) continue;
      e.closing = true;
      this.events.push({ type: 'channel-closed', ch: e.ch, groupId: e.groupId, why: event.why });
      if (event.why === 'banned') {
        const until = e.channel.bannedUntil ?? now + this.options.limits.banMs;
        if (this.identity !== undefined) this.banMember(this.identity, until);
        this.closeLink('banned');
      }
    }
  }

  private bindIdentity(peer: string, now: number): void {
    if (this.identity === undefined) {
      this.identity = peer;
      this.events.push({ type: 'identity', member: peer });
      this.checkBanned(peer, now);
    } else if (this.identity !== peer) {
      this.closeLink('identity');
    }
  }

  private checkBanned(member: string, now: number): void {
    if (this.options.bans?.isBanned(member, now) === true) this.closeLink('banned');
  }

  private banMember(member: string, until: number): void {
    this.options.bans?.ban(member, until);
    this.events.push({ type: 'banned', member, until });
  }

  private strike(reason: StrikeReason | 'probing', now: number): void {
    this.events.push({ type: 'strike', reason });
    if (this.guard.strike(now) && this.state !== 'closed') {
      if (this.identity !== undefined) this.banMember(this.identity, this.guard.bannedUntil!);
      this.closeLink('banned');
    }
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  private sendHello(now: number): void {
    this.helloSentAt = now;
    this.queueControl(
      FRAME_KIND.hello,
      0,
      encodeHello({ v: LINK_VERSION, caps: [...(this.options.caps ?? [])], n: this.myNonce }),
    );
  }

  private becomeReady(): void {
    if (this.peerNonce === undefined || this.helloSentAt === undefined || this.state !== 'hello') {
      return;
    }
    const [i, r] =
      this.options.side === 'initiator'
        ? [this.myNonce, this.peerNonce]
        : [this.peerNonce, this.myNonce];
    this.linkIdBytes = linkIdOf(this.c, i, r);
    this.linkId = toHex(this.linkIdBytes);
    this.state = 'open';
    this.events.push({ type: 'ready', linkId: this.linkId, caps: this.caps });
    for (const d of this.deferred.splice(0)) this.open(d.groupId, d.cls);
  }

  private queueControl(kind: FrameKind, ch: number, payload: Uint8Array): void {
    const f = encodeMuxFrame(kind, ch, payload, this.options.maxFrameBytes);
    if (f !== undefined) this.control.push(f);
  }

  private wrap(kind: FrameKind, ch: number, payload: Uint8Array): Uint8Array | undefined {
    if (this.outFraming === 'v1') return payload;
    return encodeMuxFrame(kind, ch, payload, this.options.maxFrameBytes);
  }

  private lanePending(lane: Lane): boolean {
    for (const e of this.channels.values()) if (e.channel.hasPending(lane)) return true;
    return false;
  }

  /** One frame of `lane`, round-robin over channels. */
  private takeFrom(lane: Lane): Uint8Array | undefined {
    const entries = [...this.channels.values()].sort((a, b) => a.ch - b.ch);
    const n = entries.length;
    for (let k = 0; k < n; k++) {
      const idx = (this.cursor[lane]! + k) % n;
      const e = entries[idx]!;
      if (!e.channel.hasPending(lane)) continue;
      const frame = e.channel.nextFrame(lane);
      if (frame === undefined) continue;
      this.cursor[lane] = (idx + 1) % n;
      // Wrap in the framing the frame was sealed for (the legacy channel's
      // `upok` is its last raw frame), then follow a switch it caused.
      const wrapped = this.wrap(FRAME_KIND.data, e.ch, frame);
      if (e.ch === 0) this.syncFraming(this.lastSent);
      if (wrapped === undefined) {
        // Larger than the carrier allows: a misconfigured session (see channelLimits). Never truncate.
        this.closeLink('oversize');
        return undefined;
      }
      return wrapped;
    }
    return undefined;
  }

  private sent(frame: Uint8Array, lane: Lane, now: number): Uint8Array {
    this.pacer.spend(frame.length, now);
    this.lastSent = now;
    this.sentByLane[lane] = this.sentByLane[lane]! + 1;
    this.reap();
    return frame;
  }

  /** Channels whose session ended and whose last frames are out: tell the peer, forget them. */
  private reap(): void {
    if (this.state === 'closed') return;
    for (const e of [...this.channels.values()]) {
      if (!e.closing || LANES.some((l) => e.channel.hasPending(l))) continue;
      if (this.outFraming === 'mux') this.queueControl(FRAME_KIND.close, e.ch, new Uint8Array(0));
      this.forget(e.ch);
      // A legacy link is its one session (raw framing: no ch-close to send).
      if (e.ch === 0 && this.endWithLegacy) this.closeLink('session-closed');
    }
  }

  private forget(ch: number): void {
    this.channels.delete(ch);
    this.recentlyClosed.push(ch);
    if (this.recentlyClosed.length > RECENTLY_CLOSED) this.recentlyClosed.shift();
  }

  /**
   * The legacy channel's v1 → mux switch points: incoming once the peer's
   * `up`/`upok` is processed, outgoing once ours is sealed (or `upok` heard).
   * The initiator holds its output in between, and the responder's `upok` is
   * the last raw frame it seals, so no frame is ever read in the wrong framing.
   */
  private syncFraming(now: number): void {
    const e = this.channels.get(0);
    if (e === undefined) return;
    if (this.inFraming === 'v1' && e.channel.upgradeIn === true) this.inFraming = 'mux';
    if (this.outFraming === 'v1' && e.channel.upgradeOut === true) {
      this.outFraming = 'mux';
      this.endWithLegacy = false;
      this.events.push({ type: 'framing', framing: 'mux' });
      this.sendHello(now);
      this.becomeReady();
    }
  }

  private isClosed(): boolean {
    return this.state === 'closed';
  }

  private closeLink(why: string): void {
    if (this.state === 'closed') return;
    for (const e of this.channels.values()) if (!e.closing) e.channel.close(why);
    this.state = 'closed';
    this.control.length = 0;
    this.events.push({ type: 'closed', why });
  }

  private allocate(): number {
    // At most MAX_CHANNELS live or opening, so a free number of our parity is always near.
    for (;;) {
      const ch = this.nextCh;
      this.nextCh += 2;
      if (this.nextCh > MAX_CHANNEL_ID) this.nextCh = this.options.side === 'initiator' ? 2 : 1;
      if (!this.channels.has(ch) && !this.opening.has(ch)) return ch;
    }
  }
}
