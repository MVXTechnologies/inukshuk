import type { SignedOp } from '../team/envelope';

/**
 * Priority lanes of a link (2.7.0 design §4.4, #705).
 *
 * Every frame a link carries belongs to one of four lanes, served by strict
 * priority: an SOS written while thousands of catch-up ops wait goes out as the
 * very next frame. Lanes 2 and 3 get a small anti-starvation quantum so a
 * steady stream of positions cannot stall catch-up forever; lane 0 never waits
 * for that quantum.
 *
 * | Lane | What |
 * |---|---|
 * | 0 urgent | `sos`/`rly` records, `pr: 2` messages, `k.rotate`, `m.remove`, `i.revoke`, handshakes |
 * | 1 live   | `pos`, `pen`, `pr: 1` messages, notes and small edits pushed live, `rtc` signalling |
 * | 2 sync   | catch-up `want`/`ops` serving, version vectors, keepalives |
 * | 3 bulk   | blob chunks |
 */
// TODO(#705 integration): G1 declares this same type in `./registry.ts`;
// import it from there once both branches land (structurally identical).
export type Lane = 0 | 1 | 2 | 3;

export const LANE_URGENT: Lane = 0;
export const LANE_LIVE: Lane = 1;
export const LANE_SYNC: Lane = 2;
export const LANE_BULK: Lane = 3;
export const LANES: readonly Lane[] = [0, 1, 2, 3];

/** Control ops that must overtake everything: a removal and its rotation lock a person out. */
export const URGENT_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'k.rotate',
  'm.remove',
  'i.revoke',
]);

/** Team-domain record kinds that are urgent (an SOS, a rally point). */
export const URGENT_KINDS: ReadonlySet<string> = new Set(['sos', 'rly']);

export function isLane(value: unknown): value is Lane {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * The lane of an op a phone is about to write and push live. The caller knows
 * the record kind (it is encrypted inside the envelope, so the session never
 * sees it); domains may override through their `lane()` hook (design §5.1).
 */
export function laneOfWrite(w: { type: string; kind?: string; pr?: number }): Lane {
  if (URGENT_CONTROL_TYPES.has(w.type)) return LANE_URGENT;
  if (w.pr === 2) return LANE_URGENT;
  if (
    (w.type === 'e.set' || w.type === 'e.del') &&
    w.kind !== undefined &&
    URGENT_KINDS.has(w.kind)
  ) {
    return LANE_URGENT;
  }
  return LANE_LIVE;
}

/**
 * The lane of an op being pushed live, from what the envelope shows in clear
 * (`t`, `pr`), raised to `hint` when the writer classified it higher (an SOS
 * record looks like any `e.set` from outside).
 */
export function laneOfOp(op: Pick<SignedOp, 'env'>, hint: Lane = LANE_LIVE): Lane {
  const own = laneOfWrite({
    type: op.env.t,
    ...(op.env.pr === undefined ? {} : { pr: op.env.pr }),
  });
  return Math.min(own, hint) as Lane;
}

/**
 * Picks which lane the next frame comes from. Strict priority, except that a
 * lane ≥ 2 that has been passed over `quantum` times in a row while it had
 * something to send is served once (anti-starvation). Lane 0 always comes
 * first: the quantum can delay lane 1, never an SOS.
 */
export class LaneScheduler {
  /** Frames served from higher lanes while each lane waited. */
  private readonly waited = [0, 0, 0, 0];

  constructor(readonly quantum = 16) {}

  /** The lane to serve next, or `undefined` when nothing is pending. */
  pick(hasPending: (lane: Lane) => boolean): Lane | undefined {
    const pending = LANES.filter((l) => hasPending(l));
    if (pending.length === 0) return undefined;
    if (pending[0] === LANE_URGENT) return LANE_URGENT;
    // Starved lanes, lowest priority first so bulk gets its turn too.
    for (let i = pending.length - 1; i >= 1; i--) {
      const lane = pending[i]!;
      if (lane >= LANE_SYNC && this.waited[lane]! >= this.quantum) return lane;
    }
    return pending[0];
  }

  /** Record that `lane` was served while the lanes in `pending` waited. */
  served(lane: Lane, hasPending: (lane: Lane) => boolean): void {
    this.waited[lane] = 0;
    for (const l of LANES) {
      if (l > lane && hasPending(l)) this.waited[l] = this.waited[l]! + 1;
      else if (l !== lane && !hasPending(l)) this.waited[l] = 0;
    }
  }
}
