/**
 * The mass-delete alarm (R-LIB-1, security review §4.4): when one author's
 * deletes reach more than {@link MASS_DELETE_COUNT} records within
 * {@link MASS_DELETE_WINDOW_MS} of **local arrival**, managers get "Bob
 * deleted 140 items · Restore all · Remove Bob".
 *
 * UI only, never a fold rule: arrival time is this phone's, so phones may
 * disagree on whether a burst crossed the line, and that is fine. A soft
 * delete of a folder weighs every record it takes with it (`trashedBy`), so
 * trashing one folder of 500 items is not a quiet way around the alarm.
 * Purges count too. An op counts once, however often it arrives.
 */
export const MASS_DELETE_COUNT = 20;
export const MASS_DELETE_WINDOW_MS = 10 * 60 * 1000;

/** One delete op as it arrived on this phone. */
export interface DeleteArrival {
  opId: string;
  author: string;
  /** Local arrival time (ms). */
  at: number;
  /** Record keys it took to the trash or purged (`lfo:<id>` / `lit:<id>`). */
  records: readonly string[];
}

export interface MassDeleteAlert {
  author: string;
  /** Records deleted in the burst so far (distinct). */
  count: number;
  /** Arrival of the burst's first and newest counted delete. */
  from: number;
  to: number;
  /** The records, in arrival order (for "Restore all"). */
  records: string[];
}

interface Burst {
  /** Arrivals inside the window, oldest first. */
  recent: DeleteArrival[];
  alert?: MassDeleteAlert;
  /** The alert's records, as a set. */
  known: Set<string>;
}

/** Per-group detector state (in memory: the alarm is about what happens now). */
export class MassDeleteDetector {
  private readonly seen = new Set<string>();
  private readonly bursts = new Map<string, Burst>();

  constructor(
    private readonly count = MASS_DELETE_COUNT,
    private readonly windowMs = MASS_DELETE_WINDOW_MS,
  ) {}

  /**
   * Note one delete. Returns the author's alert when this arrival raised or
   * grew it, else `undefined`.
   */
  note(a: DeleteArrival): MassDeleteAlert | undefined {
    if (this.seen.has(a.opId) || a.records.length === 0) return undefined;
    this.seen.add(a.opId);
    let b = this.bursts.get(a.author);
    if (b === undefined) {
      b = { recent: [], known: new Set() };
      this.bursts.set(a.author, b);
    }
    if (b.alert !== undefined) {
      // A raised alert keeps growing until a manager handles it.
      for (const r of a.records)
        if (!b.known.has(r)) {
          b.known.add(r);
          b.alert.records.push(r);
        }
      b.alert.count = b.alert.records.length;
      b.alert.to = Math.max(b.alert.to, a.at);
      return { ...b.alert, records: [...b.alert.records] };
    }
    b.recent.push(a);
    b.recent.sort((x, y) => x.at - y.at || (x.opId < y.opId ? -1 : 1));
    const newest = b.recent[b.recent.length - 1]!.at;
    b.recent = b.recent.filter((x) => newest - x.at <= this.windowMs);
    const records: string[] = [];
    const known = b.known;
    known.clear();
    for (const x of b.recent)
      for (const r of x.records)
        if (!known.has(r)) {
          known.add(r);
          records.push(r);
        }
    if (records.length <= this.count) return undefined;
    b.alert = {
      author: a.author,
      count: records.length,
      from: b.recent[0]!.at,
      to: newest,
      records,
    };
    return { ...b.alert, records: [...records] };
  }

  /** Open alerts, by author id. */
  alerts(): MassDeleteAlert[] {
    const out: MassDeleteAlert[] = [];
    for (const b of this.bursts.values())
      if (b.alert !== undefined) out.push({ ...b.alert, records: [...b.alert.records] });
    return out.sort((x, y) => (x.author < y.author ? -1 : 1));
  }

  /** A manager handled it (restored, removed the author, or dismissed). */
  dismiss(author: string): void {
    this.bursts.delete(author);
  }
}
