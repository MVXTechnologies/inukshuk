/**
 * A virtual clock with an event queue (design §8.1). Events run in time
 * order, ties in the order they were scheduled, so a run is a pure function
 * of its seed. Nothing here reads the wall clock.
 */
export class SimClock {
  now: number;
  private queue: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  /** Events run so far (a work counter for budgets and tests). */
  ran = 0;

  constructor(start: number) {
    this.now = start;
  }

  /** Run `fn` at `at` (not before now). */
  at(at: number, fn: () => void): void {
    const item = { at: Math.max(at, this.now), seq: this.seq++, fn };
    // Binary insert: (at, seq) ascending.
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const m = this.queue[mid]!;
      if (m.at < item.at || (m.at === item.at && m.seq < item.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, item);
  }

  after(ms: number, fn: () => void): void {
    this.at(this.now + ms, fn);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Run every event due up to `until`, then set the time to `until`. */
  runUntil(until: number, maxEvents = 5_000_000): void {
    while (this.queue.length > 0 && this.queue[0]!.at <= until) {
      if (this.ran >= maxEvents) throw new Error(`simulation exceeded ${maxEvents} events`);
      const next = this.queue.shift()!;
      this.now = next.at;
      this.ran++;
      next.fn();
    }
    this.now = Math.max(this.now, until);
  }
}
