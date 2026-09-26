import {
  activeBackoff,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelay,
  emptyBackoffLedger,
  recordFailure,
  recordSuccess,
  type BackoffLedger,
} from './renderBackoff';

const KEY = 'map:0';
const REV = 'maps/map.pdf@1';

describe('backoffDelay', () => {
  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50, 5000].map(backoffDelay)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('treats a nonsensical count as the first failure', () => {
    expect(backoffDelay(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(-3)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(1.9)).toBe(BACKOFF_BASE_MS);
  });
});

describe('render backoff ledger', () => {
  it('lets a key with no record through', () => {
    expect(activeBackoff(emptyBackoffLedger(), KEY, REV, 0)).toBeNull();
  });

  it('holds a failed key for the window, then lets it through', () => {
    const { ledger, report, entry } = recordFailure(emptyBackoffLedger(), KEY, REV, 'boom', 1_000);
    expect(report).toBe(true);
    expect(entry).toMatchObject({ failures: 1, retryAt: 3_000, reason: 'boom' });
    expect(activeBackoff(ledger, KEY, REV, 1_000)).toBe(entry);
    expect(activeBackoff(ledger, KEY, REV, 2_999)).toBe(entry);
    expect(activeBackoff(ledger, KEY, REV, 3_000)).toBeNull();
    // Other pages are unaffected.
    expect(activeBackoff(ledger, 'map:1', REV, 1_000)).toBeNull();
  });

  it('grows the window with consecutive failures up to the cap', () => {
    let ledger: BackoffLedger = emptyBackoffLedger();
    let now = 0;
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const next = recordFailure(ledger, KEY, REV, 'boom', now);
      ledger = next.ledger;
      waits.push(next.entry.retryAt - now);
      now = next.entry.retryAt;
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('reports a repeated failure once per capped window, and a new message at once', () => {
    let ledger: BackoffLedger = emptyBackoffLedger();
    const reports: boolean[] = [];
    for (const [reason, now] of [
      ['boom', 0],
      ['boom', 2_000],
      ['boom', 6_000],
      ['other', 7_000],
      ['other', 20_000],
      ['other', 66_999],
      ['other', 67_000],
    ] as const) {
      const next = recordFailure(ledger, KEY, REV, reason, now);
      ledger = next.ledger;
      reports.push(next.report);
    }
    expect(reports).toEqual([true, false, false, true, false, false, true]);
    expect(ledger.get(KEY)).toMatchObject({ reportedReason: 'other', reportedAt: 67_000 });
  });

  it('keeps the last reported message while a repeat is muted', () => {
    const first = recordFailure(emptyBackoffLedger(), KEY, REV, 'boom', 0);
    const second = recordFailure(first.ledger, KEY, REV, 'boom', BACKOFF_BASE_MS);
    expect(second.report).toBe(false);
    expect(second.entry).toMatchObject({ reportedReason: 'boom', reportedAt: 0, failures: 2 });
  });

  it('resets on success', () => {
    const failed = recordFailure(emptyBackoffLedger(), KEY, REV, 'boom', 0).ledger;
    const cleared = recordSuccess(failed, KEY);
    expect(activeBackoff(cleared, KEY, REV, 1)).toBeNull();
    const again = recordFailure(cleared, KEY, REV, 'boom', 10);
    expect(again.report).toBe(true);
    expect(again.entry.failures).toBe(1);
  });

  it('returns the same ledger when a success has nothing to clear', () => {
    const ledger = emptyBackoffLedger();
    expect(recordSuccess(ledger, KEY)).toBe(ledger);
  });

  it('starts clean for a new revision of the page', () => {
    let ledger = recordFailure(emptyBackoffLedger(), KEY, REV, 'boom', 0).ledger;
    ledger = recordFailure(ledger, KEY, REV, 'boom', 2_000).ledger;
    expect(activeBackoff(ledger, KEY, 'maps/map.pdf@2', 2_001)).toBeNull();
    const next = recordFailure(ledger, KEY, 'maps/map.pdf@2', 'boom', 2_001);
    expect(next.report).toBe(true);
    expect(next.entry).toMatchObject({ failures: 1, revision: 'maps/map.pdf@2' });
  });

  it('never mutates the ledger it was given', () => {
    const ledger = emptyBackoffLedger();
    recordFailure(ledger, KEY, REV, 'boom', 0);
    expect(ledger.size).toBe(0);
    expect(BACKOFF_MAX_MS).toBe(60_000);
  });
});
