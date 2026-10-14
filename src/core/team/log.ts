import { own } from './crdt';
import { expiresAt, isEphemeralType, PEN_TTL_S, type SignedOp } from './envelope';
import { compareStamp, MAX_CLOCK_LEAD_MS, type Stamp } from './hlc';

/**
 * The local op store (#589), in memory. The data layer persists the same
 * records; this class is the logic it mirrors.
 *
 * - **Logged ops** are kept by id and as *candidates* per `(author, seq)`.
 *   Normally there is one. Two or more means the author signed two histories
 *   (**equivocation**); every signed candidate is kept as proof, up to
 *   {@link MAX_FORKS} per seq. Which candidate counts is decided by the
 *   per-author hash chain (`chain.ts`), not by arrival order, so every peer
 *   holding the same ops agrees.
 * - **Ephemeral ops** (`pos`, `pen`) have `seq` 0 and no chain. Only the newest
 *   unexpired one per (author, type) is kept.
 * - A **live stroke** (`pen`, #683) lives 30 s, too short to judge against
 *   the author's clock: a receiver whose clock runs a minute ahead would drop
 *   every stroke as stale. Its life runs from its **arrival** here, at most
 *   its ttl (≤ {@link PEN_TTL_S}), and it is refused once its own expiry is
 *   more than {@link MAX_CLOCK_LEAD_MS} behind this clock (no replaying old
 *   strokes). The newest stroke stamp per author is remembered past expiry,
 *   so an older stroke never comes back.
 */
export type InsertResult = 'new' | 'duplicate' | 'fork' | 'stale' | 'full';

export type VersionVector = Record<string, number>;

/** Candidates kept per (author, seq); a pinned (chain-required) op is always admitted. */
export const MAX_FORKS = 4;

export class OpLog {
  private readonly byId = new Map<string, SignedOp>();
  private readonly bySeq = new Map<string, Map<number, string[]>>();
  /** Highest seq held per author, maintained incrementally. */
  private readonly top = new Map<string, number>();
  private readonly ephemeral = new Map<string, SignedOp>();
  /** `pen` only: when each held stroke goes, by this clock (arrival + ttl). */
  private readonly penDeadline = new Map<string, number>();
  /** `pen` only: the newest stroke stamp ever held per author (≤ one per member). */
  private readonly penNewest = new Map<string, Stamp>();
  private loggedBytes = 0;
  /** `[firstOpId, conflictingOpId]`: both signed ops stay retrievable with `get`. */
  readonly equivocations: [string, string][] = [];

  /** `pinned`: the id the author's anchored chain requires at this seq, if known. */
  insert(op: SignedOp, now: number, pinned?: string): InsertResult {
    const { env } = op;
    if (isEphemeralType(env.t)) {
      const key = `${env.au}|${env.t}`;
      const pen = env.t === 'pen';
      if (pen ? !penFresh(op, now) : isPast(expiresAt(env), now)) return 'stale';
      const prev = this.ephemeral.get(key);
      if (prev?.id === op.id) return 'duplicate';
      const newest = pen ? this.penNewest.get(key) : prev?.stamp;
      if (newest !== undefined && compareStamp(newest, op.stamp) >= 0) return 'stale';
      this.ephemeral.set(key, op);
      if (pen) {
        this.penNewest.set(key, op.stamp);
        this.penDeadline.set(key, now + Math.min(env.ttl ?? 0, PEN_TTL_S) * 1000);
      }
      return 'new';
    }
    if (this.byId.has(op.id)) return 'duplicate';
    let seqs = this.bySeq.get(env.au);
    if (seqs === undefined) {
      seqs = new Map();
      this.bySeq.set(env.au, seqs);
    }
    const cands = seqs.get(env.sq) ?? [];
    if (cands.length >= MAX_FORKS && op.id !== pinned) return 'full';
    cands.push(op.id);
    seqs.set(env.sq, cands);
    this.top.set(env.au, Math.max(this.top.get(env.au) ?? 0, env.sq));
    this.byId.set(op.id, op);
    this.loggedBytes += op.bytes;
    if (cands.length > 1) {
      this.equivocations.push([cands[0]!, op.id]);
      return 'fork';
    }
    return 'new';
  }

  has(id: string): boolean {
    return this.byId.has(id) || [...this.ephemeral.values()].some((op) => op.id === id);
  }

  get(id: string): SignedOp | undefined {
    return this.byId.get(id);
  }

  /** Every candidate held for one author and seq. */
  candidates(author: string, seq: number): SignedOp[] {
    return (this.bySeq.get(author)?.get(seq) ?? []).map((id) => this.byId.get(id)!);
  }

  maxSeq(author: string): number {
    return this.top.get(author) ?? 0;
  }

  logged(): SignedOp[] {
    return [...this.byId.values()];
  }

  /** Unexpired ephemeral ops (dropping expired ones as a side effect). */
  liveEphemeral(now: number): SignedOp[] {
    for (const [key, op] of this.ephemeral) {
      const gone =
        op.env.t === 'pen'
          ? !penFresh(op, now) || isPast(this.penDeadline.get(key), now)
          : isPast(expiresAt(op.env), now);
      if (gone) {
        this.ephemeral.delete(key);
        this.penDeadline.delete(key);
      }
    }
    return [...this.ephemeral.values()];
  }

  /**
   * When a held ephemeral op goes, by this device's clock: a `pen` by its
   * arrival (see the class note), anything else by its own expiry.
   */
  ephemeralDeadline(op: SignedOp): number | undefined {
    const key = `${op.env.au}|${op.env.t}`;
    if (op.env.t === 'pen' && this.ephemeral.get(key)?.id === op.id) {
      return this.penDeadline.get(key);
    }
    return expiresAt(op.env);
  }

  /** Forget a removed member's ops past their cut. */
  dropAbove(author: string, cut: number): number {
    const seqs = this.bySeq.get(author);
    if (seqs === undefined) return 0;
    let dropped = 0;
    for (const [s, ids] of [...seqs]) {
      if (s <= cut) continue;
      for (const id of ids) {
        const op = this.byId.get(id);
        if (op !== undefined) this.loggedBytes -= op.bytes;
        this.byId.delete(id);
        dropped++;
      }
      seqs.delete(s);
    }
    let top = 0;
    for (const s of seqs.keys()) if (s > top) top = s;
    this.top.set(author, top);
    return dropped;
  }

  get size(): number {
    return this.byId.size;
  }

  get bytes(): number {
    return this.loggedBytes;
  }
}

const isPast = (deadline: number | undefined, now: number) =>
  deadline !== undefined && deadline < now;

/** A stroke whose own expiry is within this clock's tolerated lead (not a replay). */
const penFresh = (op: SignedOp, now: number) =>
  !isPast((expiresAt(op.env) ?? 0) + MAX_CLOCK_LEAD_MS, now);

/**
 * What `mine` should ask `theirs` for: per author, the seqs they hold
 * contiguously that we don't. `[author, from, to]`, sorted.
 */
export function missingRanges(
  mine: VersionVector,
  theirs: VersionVector,
): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const author of Object.keys(theirs).sort()) {
    const have = own(mine, author) ?? 0;
    const offer = own(theirs, author) ?? 0;
    if (offer > have) out.push([author, have + 1, offer]);
  }
  return out;
}
