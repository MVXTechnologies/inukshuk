/**
 * Per-peer flood protection (#589, owner's anti-DDoS requirement).
 *
 * A peer is just another phone, and any phone can be buggy or hostile. Each
 * sync session keeps a {@link PeerGuard}:
 * - **frame size cap**, checked on the raw byte length before anything is
 *   decrypted or parsed;
 * - **token buckets** for bytes and frames per second, and for *unsolicited*
 *   ops per category (ops we asked for are paced by our own requests);
 * - **strikes** for malformed frames, bad signatures, oversize or
 *   over-rate traffic; enough strikes inside the window bans the peer for a
 *   while (the transport drops its connections and ignores its adverts).
 *
 * All limits are per transport profile: a LAN can carry megabytes per second,
 * a Nostr relay (later) a few kilobytes.
 */
export class TokenBucket {
  private tokens: number;
  private last: number | undefined;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  /** Take `n` tokens at time `now` (ms); false (and nothing taken) when not enough. */
  take(n: number, now: number): boolean {
    if (this.last !== undefined && now > this.last) {
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((now - this.last) / 1000) * this.ratePerSec,
      );
    }
    this.last = this.last === undefined ? now : Math.max(this.last, now);
    if (n > this.tokens) return false;
    this.tokens -= n;
    return true;
  }
}

export type OpCategory = 'control' | 'data' | 'msg' | 'pos';

export interface PeerLimits {
  maxFrameBytes: number;
  bytesPerSec: number;
  burstBytes: number;
  framesPerSec: number;
  burstFrames: number;
  /** Unsolicited ops per category: [per second, burst]. */
  ops: Record<OpCategory, [number, number]>;
  /** Strikes within `strikeWindowMs` that trigger a ban. */
  strikesToBan: number;
  strikeWindowMs: number;
  banMs: number;
}

/** Phones on the same Wi-Fi or hotspot. */
export const LAN_LIMITS: PeerLimits = {
  maxFrameBytes: 512 * 1024,
  bytesPerSec: 4 * 1024 * 1024,
  burstBytes: 8 * 1024 * 1024,
  framesPerSec: 200,
  burstFrames: 400,
  ops: {
    control: [5, 50],
    data: [20, 200],
    msg: [10, 100],
    // 500 members relaying positions every ~10 s.
    pos: [60, 600],
  },
  strikesToBan: 20,
  strikeWindowMs: 60_000,
  banMs: 10 * 60_000,
};

/** Third-party relays (Nostr, later): tiny budgets, the relay is shared with strangers. */
export const RELAY_LIMITS: PeerLimits = {
  maxFrameBytes: 128 * 1024,
  bytesPerSec: 64 * 1024,
  burstBytes: 512 * 1024,
  framesPerSec: 20,
  burstFrames: 60,
  ops: { control: [1, 20], data: [5, 50], msg: [5, 50], pos: [10, 100] },
  strikesToBan: 10,
  strikeWindowMs: 60_000,
  banMs: 30 * 60_000,
};

export type StrikeReason =
  'oversize' | 'rate' | 'malformed' | 'decrypt' | 'signature' | 'protocol' | 'unsolicited';

export class PeerGuard {
  private readonly bytes: TokenBucket;
  private readonly frames: TokenBucket;
  private readonly ops: Record<OpCategory, TokenBucket>;
  private strikes: number[] = [];
  bannedUntil: number | undefined;

  constructor(readonly limits: PeerLimits = LAN_LIMITS) {
    this.bytes = new TokenBucket(limits.bytesPerSec, limits.burstBytes);
    this.frames = new TokenBucket(limits.framesPerSec, limits.burstFrames);
    this.ops = {
      control: new TokenBucket(...limits.ops.control),
      data: new TokenBucket(...limits.ops.data),
      msg: new TokenBucket(...limits.ops.msg),
      pos: new TokenBucket(...limits.ops.pos),
    };
  }

  isBanned(now: number): boolean {
    return this.bannedUntil !== undefined && now < this.bannedUntil;
  }

  /** Check a raw frame before touching its content. */
  admitFrame(size: number, now: number): 'ok' | 'oversize' | 'rate' {
    if (size > this.limits.maxFrameBytes) return 'oversize';
    if (!this.frames.take(1, now) || !this.bytes.take(size, now)) return 'rate';
    return 'ok';
  }

  admitOp(category: OpCategory, now: number): boolean {
    return this.ops[category].take(1, now);
  }

  /** Record a strike; returns true when this one triggers a ban. */
  strike(now: number): boolean {
    this.strikes = this.strikes.filter((t) => now - t < this.limits.strikeWindowMs);
    this.strikes.push(now);
    if (this.strikes.length >= this.limits.strikesToBan) {
      this.bannedUntil = now + this.limits.banMs;
      return true;
    }
    return false;
  }
}

export function categoryOf(type: string): OpCategory {
  if (type === 'pos') return 'pos';
  if (type === 'msg') return 'msg';
  if (type.startsWith('e.')) return 'data';
  return 'control';
}
