import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelayMs,
  canSendReport,
  emptyQueueDoc,
  ERROR_QUEUE_SCHEMA_VERSION,
  MAX_QUEUED_REPORTS,
  mergeReport,
  migrateErrorQueueDoc,
  pruneSentHistory,
} from './queue';
import type { ErrorReport } from './types';

function report(overrides: Partial<ErrorReport> = {}): ErrorReport {
  return {
    fingerprint: 'aabbccdd',
    message: 'boom',
    isFatal: false,
    breadcrumbs: [],
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    environment: { appVersion: '1.0.5', os: 'android 16' },
    ...overrides,
  };
}

describe('mergeReport', () => {
  it('appends a new fingerprint', () => {
    const queue = mergeReport([], report());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.count).toBe(1);
  });

  it('folds a repeat fingerprint into the existing entry', () => {
    const queue = mergeReport(
      [report()],
      report({ lastSeenAt: 2000, isFatal: true, message: 'boom again' }),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]?.count).toBe(2);
    expect(queue[0]?.lastSeenAt).toBe(2000);
    expect(queue[0]?.isFatal).toBe(true);
    // The first-seen message is authoritative.
    expect(queue[0]?.message).toBe('boom');
  });

  it('never downgrades a fatal entry to non-fatal', () => {
    const queue = mergeReport([report({ isFatal: true })], report({ isFatal: false }));
    expect(queue[0]?.isFatal).toBe(true);
  });

  it('drops the oldest entries beyond the cap', () => {
    let queue: ErrorReport[] = [];
    for (let i = 0; i < MAX_QUEUED_REPORTS + 3; i++) {
      queue = mergeReport(queue, report({ fingerprint: `fp-${i}` }));
    }
    expect(queue).toHaveLength(MAX_QUEUED_REPORTS);
    expect(queue[0]?.fingerprint).toBe('fp-3');
    expect(queue.at(-1)?.fingerprint).toBe(`fp-${MAX_QUEUED_REPORTS + 2}`);
  });
});

describe('rate limiting', () => {
  const HOUR = 60 * 60 * 1000;

  it('prunes timestamps outside the rolling window (and bogus future ones)', () => {
    const now = 100 * HOUR;
    expect(pruneSentHistory([now - 25 * HOUR, now - 23 * HOUR, now - 1, now + HOUR], now)).toEqual([
      now - 23 * HOUR,
      now - 1,
    ]);
  });

  it('allows sending below the daily cap and blocks at it', () => {
    const now = 100 * HOUR;
    const recent = (n: number) => Array.from({ length: n }, (_, i) => now - (i + 1) * HOUR);
    expect(canSendReport(recent(4), now, 5)).toBe(true);
    expect(canSendReport(recent(5), now, 5)).toBe(false);
  });

  it('frees capacity as old deliveries age out', () => {
    const now = 100 * HOUR;
    const history = [now - 30 * HOUR, now - 29 * HOUR, now - 2 * HOUR];
    expect(canSendReport(history, now, 3)).toBe(true);
  });
});

describe('migrateErrorQueueDoc', () => {
  it('returns an empty doc for junk input', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { queue: 'x' }]) {
      expect(migrateErrorQueueDoc(junk)).toEqual(emptyQueueDoc());
    }
  });

  it('keeps valid reports and drops malformed entries', () => {
    const doc = migrateErrorQueueDoc({
      schemaVersion: ERROR_QUEUE_SCHEMA_VERSION,
      queue: [report(), { fingerprint: '', message: 'no fp' }, { message: 'no fp at all' }, 7],
      sentHistory: [123, 'junk', Infinity, 456],
    });
    expect(doc.queue).toEqual([report()]);
    expect(doc.sentHistory).toEqual([123, 456]);
  });

  it('fills defaults for missing report fields', () => {
    const doc = migrateErrorQueueDoc({
      queue: [{ fingerprint: 'ff00ff00', message: 'partial', count: 2.9, breadcrumbs: [1, 'ok'] }],
    });
    const r = doc.queue[0];
    expect(r).toMatchObject({
      fingerprint: 'ff00ff00',
      message: 'partial',
      isFatal: false,
      count: 2,
      breadcrumbs: ['ok'],
      firstSeenAt: 0,
      lastSeenAt: 0,
      environment: { appVersion: 'unknown', os: 'unknown' },
    });
  });

  it('caps a bloated persisted queue to the newest entries', () => {
    const doc = migrateErrorQueueDoc({
      queue: Array.from({ length: MAX_QUEUED_REPORTS + 5 }, (_, i) =>
        report({ fingerprint: `fp-${i}` }),
      ),
    });
    expect(doc.queue).toHaveLength(MAX_QUEUED_REPORTS);
    expect(doc.queue[0]?.fingerprint).toBe('fp-5');
  });
});

describe('backoffDelayMs', () => {
  it('does not delay when nothing has failed', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-1)).toBe(0);
  });

  it('backs off exponentially from the base delay', () => {
    expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3)).toBe(BACKOFF_BASE_MS * 4);
  });

  it('clamps at the ceiling, even after a very long offline stretch', () => {
    expect(backoffDelayMs(20)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(5000)).toBe(BACKOFF_MAX_MS);
  });
});
