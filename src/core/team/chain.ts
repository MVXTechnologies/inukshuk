import type { SignedOp } from './envelope';

/**
 * Per-author hash chains (#589, review H3).
 *
 * Every logged op from seq 2 names its predecessor (`pv` = previous op id),
 * so an author's ops form a signed chain. When an author equivocates (signs two
 * different ops for one seq), the chain decides which history counts, the
 * same way on every peer:
 *
 * - **Anchored** authors (removed or demoted with a cut `[seq, opId]`): the
 *   chain is pinned top-down from the anchor through `pv` links. A different
 *   op at any seq at or below the cut is never canonical, whenever and however
 *   it arrives. Removal stops the chain at the anchor; a demotion pins only
 *   the history below it.
 * - **Unanchored** authors: bottom-up, at each seq, the candidates linking to
 *   the previous canonical op; ties (an equivocation) go to the lowest op id.
 *   Deterministic for a given op set. Equivocation is surfaced as evidence so
 *   an admin removes the member, which anchors the chain.
 *
 * The chain length is the author's version-vector entry, so a peer whose
 * pinned chain breaks (it holds a forged op where the anchor needs another)
 * reports a shorter vector and pulls the real op again.
 */
export interface Anchor {
  seq: number;
  /** Op id at `seq` (empty when `seq` is 0). */
  id: string;
  /** Removal: nothing after the anchor is canonical. Demotion: the chain continues. */
  stop: boolean;
}

export interface CandidateSource {
  candidates(author: string, seq: number): readonly SignedOp[];
  get(id: string): SignedOp | undefined;
  maxSeq(author: string): number;
}

export interface Chain {
  /** Canonical op ids, index = seq − 1, contiguous from seq 1. */
  ids: string[];
  /** Ids the anchor requires per seq (known top-down through held ops). */
  pinned: Map<number, string>;
}

export function canonicalChain(src: CandidateSource, author: string, anchor?: Anchor): Chain {
  const pinned = new Map<number, string>();
  if (anchor !== undefined && anchor.seq >= 1) {
    let cur: string | undefined = anchor.id;
    for (let s = anchor.seq; s >= 1 && cur !== undefined; s--) {
      pinned.set(s, cur);
      const op = src.get(cur);
      if (op === undefined || op.env.au !== author || op.env.sq !== s) break;
      cur = op.env.pv;
    }
  }
  const limit = anchor?.stop === true ? anchor.seq : src.maxSeq(author);
  const ids: string[] = [];
  let prev: string | undefined;
  for (let s = 1; s <= limit; s++) {
    const want = pinned.get(s);
    let pick: SignedOp | undefined;
    for (const op of src.candidates(author, s)) {
      if (op.env.pv !== prev) continue;
      if (want !== undefined ? op.id === want : pick === undefined || op.id < pick.id) pick = op;
    }
    if (pick === undefined) break;
    ids.push(pick.id);
    prev = pick.id;
  }
  return { ids, pinned };
}

/** An index over a plain op list, for folding without an `OpLog`. */
export function indexOps(ops: readonly SignedOp[]): CandidateSource & { authors: string[] } {
  const byId = new Map<string, SignedOp>();
  const bySeq = new Map<string, Map<number, SignedOp[]>>();
  const top = new Map<string, number>();
  for (const op of ops) {
    if (op.env.sq === 0 || byId.has(op.id)) continue;
    byId.set(op.id, op);
    top.set(op.env.au, Math.max(top.get(op.env.au) ?? 0, op.env.sq));
    let seqs = bySeq.get(op.env.au);
    if (!seqs) bySeq.set(op.env.au, (seqs = new Map()));
    const list = seqs.get(op.env.sq) ?? [];
    list.push(op);
    seqs.set(op.env.sq, list);
  }
  return {
    authors: [...bySeq.keys()],
    get: (id) => byId.get(id),
    candidates: (a, s) => bySeq.get(a)?.get(s) ?? [],
    // Tracked while indexing: never spread an unbounded collection into a call (re-review #2).
    maxSeq: (a) => top.get(a) ?? 0,
  };
}
