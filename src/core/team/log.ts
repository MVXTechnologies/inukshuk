import { expiresAt, isEphemeralType, type SignedOp } from './envelope';
import { compareStamp } from './hlc';

/**
 * The local op store (#589), in memory. The data layer persists the same
 * records (append-only segments per author); this class is the logic it
 * mirrors and what the sync tests run against.
 *
 * - **Logged ops** are keyed by id and by `(author, seq)`. A second, different
 *   op for an `(author, seq)` already held is **equivocation** (a member
 *   signing two histories): the first one stays, the pair is kept as evidence
 *   for the admins (the fix is removing that member).
 * - **Version vector** = per author, the highest `seq` such that 1…seq are all
 *   held. Gaps (relayed ops arriving out of order) are fine: the vector just
 *   doesn't advance past them, so the next sync asks again.
 * - **Ephemeral ops** (`pos`) have `seq` 0, are never in the vector, and only
 *   the newest unexpired one per (author, type) is kept.
 */
export type InsertResult = 'new' | 'duplicate' | 'equivocation' | 'stale';

export type VersionVector = Record<string, number>;

export class OpLog {
  private readonly byId = new Map<string, SignedOp>();
  private readonly bySeq = new Map<string, Map<number, string>>();
  private readonly vv = new Map<string, number>();
  private readonly ephemeral = new Map<string, SignedOp>();
  private loggedBytes = 0;
  /** `[keptOpId, conflictingOpId]` pairs. */
  readonly equivocations: [string, string][] = [];

  insert(op: SignedOp, now: number): InsertResult {
    const { env } = op;
    if (isEphemeralType(env.t)) {
      const exp = expiresAt(env);
      if (exp !== undefined && exp < now) return 'stale';
      const key = `${env.au}|${env.t}`;
      const prev = this.ephemeral.get(key);
      if (prev?.id === op.id) return 'duplicate';
      if (prev !== undefined && compareStamp(prev.stamp, op.stamp) >= 0) return 'stale';
      this.ephemeral.set(key, op);
      return 'new';
    }
    if (this.byId.has(op.id)) return 'duplicate';
    let seqs = this.bySeq.get(env.au);
    const held = seqs?.get(env.sq);
    if (held !== undefined) {
      this.equivocations.push([held, op.id]);
      return 'equivocation';
    }
    if (seqs === undefined) {
      seqs = new Map();
      this.bySeq.set(env.au, seqs);
    }
    seqs.set(env.sq, op.id);
    this.byId.set(op.id, op);
    this.loggedBytes += op.bytes;
    let top = this.vv.get(env.au) ?? 0;
    while (seqs.has(top + 1)) top++;
    this.vv.set(env.au, top);
    return 'new';
  }

  has(id: string): boolean {
    return this.byId.has(id) || [...this.ephemeral.values()].some((op) => op.id === id);
  }

  get(id: string): SignedOp | undefined {
    return this.byId.get(id);
  }

  /** Held seq for an author, if any. */
  idAt(author: string, seq: number): string | undefined {
    return this.bySeq.get(author)?.get(seq);
  }

  logged(): SignedOp[] {
    return [...this.byId.values()];
  }

  /** Unexpired ephemeral ops (dropping expired ones as a side effect). */
  liveEphemeral(now: number): SignedOp[] {
    for (const [key, op] of this.ephemeral) {
      const exp = expiresAt(op.env);
      if (exp !== undefined && exp < now) this.ephemeral.delete(key);
    }
    return [...this.ephemeral.values()];
  }

  versionVector(): VersionVector {
    return Object.fromEntries(
      [...this.vv].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }

  /** Ops `from..to` (inclusive) of one author that we hold, in seq order. */
  range(author: string, from: number, to: number): SignedOp[] {
    const seqs = this.bySeq.get(author);
    if (seqs === undefined) return [];
    const out: SignedOp[] = [];
    for (let s = Math.max(1, from); s <= to; s++) {
      const id = seqs.get(s);
      if (id === undefined) break; // ranges are contiguous
      out.push(this.byId.get(id)!);
    }
    return out;
  }

  /** Forget a removed member's ops past their cut (never stored again either: see replica). */
  dropAbove(author: string, cut: number): number {
    const seqs = this.bySeq.get(author);
    if (seqs === undefined) return 0;
    let dropped = 0;
    for (const [s, id] of [...seqs]) {
      if (s <= cut) continue;
      const op = this.byId.get(id);
      if (op !== undefined) this.loggedBytes -= op.bytes;
      this.byId.delete(id);
      seqs.delete(s);
      dropped++;
    }
    this.vv.set(author, Math.min(this.vv.get(author) ?? 0, cut));
    return dropped;
  }

  get size(): number {
    return this.byId.size;
  }

  get bytes(): number {
    return this.loggedBytes;
  }
}

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
    const have = mine[author] ?? 0;
    const offer = theirs[author] ?? 0;
    if (offer > have) out.push([author, have + 1, offer]);
  }
  return out;
}
