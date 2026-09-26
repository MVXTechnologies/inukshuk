/**
 * A per-page failure ledger with exponential backoff for PDF renders that fail
 * without the page itself being at fault (#382).
 *
 * The detail worker re-plans its tiles on every camera change and, before
 * this, re-attempted every one of them. A failure that is deliberately NOT
 * quarantined — the source could not be prepared, or the engine never took
 * the request — therefore failed again on every pan and pinch, and each
 * failure was reported: one iPhone sent 677 identical reports in 2.5 minutes.
 * The ledger makes a failing page sit out a growing window instead (2 s, 4 s,
 * … capped at 60 s), resets on the first success or on a new revision of the
 * page's file, and allows the same failure to be reported at most once per
 * capped window.
 *
 * Pure and immutable: every update returns a new ledger.
 */

/** The first retry waits this long; each further consecutive failure doubles it. */
export const BACKOFF_BASE_MS = 2_000;
/** Longest wait between attempts, and the interval a repeated report is muted for. */
export const BACKOFF_MAX_MS = 60_000;

export interface BackoffEntry {
  /** The page revision the failures belong to; any other revision starts clean. */
  readonly revision: string;
  /** Consecutive failures of this revision. */
  readonly failures: number;
  /** No attempt before this time (ms since epoch). */
  readonly retryAt: number;
  /** The latest failure's message — what the status line keeps showing. */
  readonly reason: string;
  /** The message last reported, and when. */
  readonly reportedReason: string;
  readonly reportedAt: number;
}

export type BackoffLedger = ReadonlyMap<string, BackoffEntry>;

export const emptyBackoffLedger = (): BackoffLedger => new Map();

/** Wait after the `failures`-th consecutive failure (1 → base), capped. */
export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.floor(failures) - 1));
}

/**
 * The entry that keeps `key` from being attempted at `now`, or `null` when
 * it may be attempted: no failure on record, a different revision, or the
 * window is over.
 */
export function activeBackoff(
  ledger: BackoffLedger,
  key: string,
  revision: string,
  now: number,
): BackoffEntry | null {
  const entry = ledger.get(key);
  if (!entry || entry.revision !== revision || now >= entry.retryAt) return null;
  return entry;
}

/**
 * Record a failure of `key` at `now`. `report` says whether this failure
 * should be reported: a first failure, a different message, or the same
 * message once a full capped window has passed since it was last reported.
 */
export function recordFailure(
  ledger: BackoffLedger,
  key: string,
  revision: string,
  reason: string,
  now: number,
): { ledger: BackoffLedger; report: boolean; entry: BackoffEntry } {
  const previous = ledger.get(key);
  const same = previous?.revision === revision ? previous : undefined;
  const failures = (same?.failures ?? 0) + 1;
  const report =
    same === undefined || same.reportedReason !== reason || now - same.reportedAt >= BACKOFF_MAX_MS;
  const entry: BackoffEntry = {
    revision,
    failures,
    retryAt: now + backoffDelay(failures),
    reason,
    reportedReason: same && !report ? same.reportedReason : reason,
    reportedAt: same && !report ? same.reportedAt : now,
  };
  const next = new Map(ledger);
  next.set(key, entry);
  return { ledger: next, report, entry };
}

/** A success clears the key's record (the next failure starts over at the base delay). */
export function recordSuccess(ledger: BackoffLedger, key: string): BackoffLedger {
  if (!ledger.has(key)) return ledger;
  const next = new Map(ledger);
  next.delete(key);
  return next;
}
