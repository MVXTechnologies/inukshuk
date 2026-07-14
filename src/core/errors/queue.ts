import type { ErrorQueueDoc, ErrorReport } from './types';

/**
 * Pure queue logic for the durable error-report queue: merge/dedupe, size cap,
 * client-side rate limiting, and total sanitization of the persisted document
 * (errors often happen mid-crash — a torn or junk file must never take the
 * reporter down with it).
 */

/** Current `error-reports.json` schema. */
export const ERROR_QUEUE_SCHEMA_VERSION = 1;

/** Queue size cap: beyond this the oldest reports are dropped. */
export const MAX_QUEUED_REPORTS = 20;

/** Client-side rate limit: at most this many deliveries per rolling day. */
export const MAX_REPORTS_PER_DAY = 5;

/** Rolling rate-limit window (24 h). */
export const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function emptyQueueDoc(): ErrorQueueDoc {
  return { schemaVersion: ERROR_QUEUE_SCHEMA_VERSION, queue: [], sentHistory: [] };
}

/**
 * Merge a newly captured report into the queue. A report with an already
 * queued fingerprint folds into the existing entry (count + lastSeenAt —
 * keeping the queue small and the eventual issue accurate); a new fingerprint
 * appends. If the queue exceeds {@link MAX_QUEUED_REPORTS}, the oldest entries
 * are dropped — the newest crash is the one most worth keeping.
 */
export function mergeReport(
  queue: ErrorReport[],
  incoming: ErrorReport,
  maxQueued = MAX_QUEUED_REPORTS,
): ErrorReport[] {
  const existing = queue.find((r) => r.fingerprint === incoming.fingerprint);
  if (existing) {
    return queue.map((r) =>
      r === existing
        ? {
            ...r,
            count: r.count + incoming.count,
            lastSeenAt: Math.max(r.lastSeenAt, incoming.lastSeenAt),
            // A fatal occurrence upgrades the queued entry; never downgrades.
            isFatal: r.isFatal || incoming.isFatal,
          }
        : r,
    );
  }
  const next = [...queue, incoming];
  return next.length > maxQueued ? next.slice(next.length - maxQueued) : next;
}

/** Drop delivery timestamps older than the rolling rate-limit window. */
export function pruneSentHistory(
  sentHistory: number[],
  now: number,
  windowMs = RATE_LIMIT_WINDOW_MS,
): number[] {
  return sentHistory.filter((t) => t > now - windowMs && t <= now);
}

/**
 * Client-side rate-limit decision: may one more report be delivered now?
 * Prevents a crash loop from flooding the repo with API calls.
 */
export function canSendReport(
  sentHistory: number[],
  now: number,
  maxPerDay = MAX_REPORTS_PER_DAY,
  windowMs = RATE_LIMIT_WINDOW_MS,
): boolean {
  return pruneSentHistory(sentHistory, now, windowMs).length < maxPerDay;
}

// --- retry / backoff ----------------------------------------------------------

/** Delay before the first retry after a transient delivery failure. */
export const BACKOFF_BASE_MS = 30_000;

/** Ceiling for the exponential backoff (also the offline steady-state period). */
export const BACKOFF_MAX_MS = 60 * 60 * 1000;

/**
 * How long to wait before the next delivery attempt after `failures` consecutive
 * transient failures (offline, 5xx, 429): exponential from
 * {@link BACKOFF_BASE_MS}, clamped at {@link BACKOFF_MAX_MS}. Deterministic (no
 * jitter): a single client filing at most a handful of reports a day cannot
 * thunder anyone, and determinism keeps it testable.
 */
export function backoffDelayMs(
  failures: number,
  baseMs = BACKOFF_BASE_MS,
  maxMs = BACKOFF_MAX_MS,
): number {
  if (failures <= 0) return 0;
  // Cap the exponent before shifting so a long-offline session can't overflow.
  const exponent = Math.min(failures - 1, 20);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

// --- persisted-document sanitization ----------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Total per-report sanitizer: junk in, a usable report (or null) out. */
function sanitizeReport(raw: unknown): ErrorReport | null {
  if (!isRecord(raw)) return null;
  const fingerprint = asString(raw.fingerprint);
  const message = asString(raw.message);
  if (fingerprint === undefined || fingerprint === '' || message === undefined) return null;
  const env = isRecord(raw.environment) ? raw.environment : {};
  const firstSeenAt = asFiniteNumber(raw.firstSeenAt) ?? 0;
  return {
    fingerprint,
    message,
    ...(asString(raw.stack) !== undefined ? { stack: asString(raw.stack) } : {}),
    ...(asString(raw.componentStack) !== undefined
      ? { componentStack: asString(raw.componentStack) }
      : {}),
    isFatal: raw.isFatal === true,
    ...(asString(raw.context) !== undefined ? { context: asString(raw.context) } : {}),
    breadcrumbs: Array.isArray(raw.breadcrumbs)
      ? raw.breadcrumbs.filter((b): b is string => typeof b === 'string')
      : [],
    firstSeenAt,
    lastSeenAt: asFiniteNumber(raw.lastSeenAt) ?? firstSeenAt,
    count: Math.max(1, Math.floor(asFiniteNumber(raw.count) ?? 1)),
    environment: {
      appVersion: asString(env.appVersion) ?? 'unknown',
      ...(asString(env.runtimeVersion) !== undefined
        ? { runtimeVersion: asString(env.runtimeVersion) }
        : {}),
      ...(asString(env.updateId) !== undefined ? { updateId: asString(env.updateId) } : {}),
      os: asString(env.os) ?? 'unknown',
      ...(asString(env.model) !== undefined ? { model: asString(env.model) } : {}),
    },
  };
}

/**
 * Migrate/sanitize a raw parsed `error-reports.json` (any version, or junk)
 * to the current {@link ErrorQueueDoc}. Never throws.
 */
export function migrateErrorQueueDoc(raw: unknown): ErrorQueueDoc {
  const doc = isRecord(raw) ? raw : {};
  const queue = (Array.isArray(doc.queue) ? doc.queue : [])
    .map(sanitizeReport)
    .filter((r): r is ErrorReport => r !== null)
    .slice(-MAX_QUEUED_REPORTS);
  const sentHistory = (Array.isArray(doc.sentHistory) ? doc.sentHistory : []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t),
  );
  return { schemaVersion: ERROR_QUEUE_SCHEMA_VERSION, queue, sentHistory };
}
