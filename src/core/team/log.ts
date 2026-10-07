import { own } from './crdt';
import { expiresAt, isEphemeralType, type SignedOp } from './envelope';
import { compareStamp } from './hlc';

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
 * - **Ephemeral ops** (`pos`) have `seq` 0 and no chain. Only the newest
 *   unexpired one per (author, type) is kept.
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
  private loggedBytes = 0;
  /** `[firstOpId, conflictingOpId]`: both signed ops stay retrievable with `get`. */
  readonly equivocations: [string, string][] = [];

  /** `pinned`: the id the author's anchored chain requires at this seq, if known. */
  insert(op: SignedOp, now: number, pinned?: string): InsertResult {
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
      const exp = expiresAt(op.env);
      if (exp !== undefined && exp < now) this.ephemeral.delete(key);
    }
    return [...this.ephemeral.values()];
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
