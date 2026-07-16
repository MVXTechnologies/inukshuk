import {
  assessDiskBudget,
  formatByteSize,
  isOutOfSpaceMessage,
  DEFAULT_SAFETY_MARGIN_BYTES,
} from './diskBudget';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe('assessDiskBudget', () => {
  it('proceeds when there is plenty of headroom (enough)', () => {
    const a = assessDiskBudget(4 * GB, 100 * MB);
    expect(a.verdict).toBe('proceed');
    expect(a.message).toBeNull();
  });

  it('warns but allows when the download fits yet eats into the safety margin (tight)', () => {
    // free is above the estimate but below estimate + default margin.
    const free = 250 * MB;
    const estimate = 100 * MB; // required = 100 + 200 = 300 MB > 250 MB free
    const a = assessDiskBudget(free, estimate);
    expect(a.verdict).toBe('warn');
    expect(a.message).toMatch(/nearly all/i);
  });

  it('blocks when the download cannot fit at all (insufficient)', () => {
    const a = assessDiskBudget(180 * MB, 420 * MB);
    expect(a.verdict).toBe('block');
    expect(a.message).toContain('420 MB');
    expect(a.message).toContain('180 MB');
  });

  it('always proceeds on a zero / unknown estimate', () => {
    expect(assessDiskBudget(1 * MB, 0).verdict).toBe('proceed');
    expect(assessDiskBudget(0, 0).verdict).toBe('proceed');
    expect(assessDiskBudget(1 * MB, -5).verdict).toBe('proceed');
    expect(assessDiskBudget(1 * MB, Number.NaN).verdict).toBe('proceed');
  });

  it('honours a custom safety margin (margin)', () => {
    const free = 250 * MB;
    const estimate = 100 * MB;
    // With no margin the same inputs comfortably proceed...
    expect(assessDiskBudget(free, estimate, { safetyMarginBytes: 0 }).verdict).toBe('proceed');
    // ...but a large margin turns it into a warn.
    expect(assessDiskBudget(free, estimate, { safetyMarginBytes: 500 * MB }).verdict).toBe('warn');
    // requiredBytes reflects the margin.
    const a = assessDiskBudget(free, estimate, { safetyMarginBytes: 300 * MB });
    expect(a.requiredBytes).toBe(estimate + 300 * MB);
  });

  it('treats an unreadable (negative / NaN) free-space reading as zero', () => {
    expect(assessDiskBudget(Number.NaN, 100 * MB).verdict).toBe('block');
    expect(assessDiskBudget(-1, 100 * MB).verdict).toBe('block');
  });

  it('exposes a sane default safety margin', () => {
    expect(DEFAULT_SAFETY_MARGIN_BYTES).toBe(200 * MB);
  });
});

describe('formatByteSize (byte-formatting)', () => {
  it('formats MB without decimals', () => {
    expect(formatByteSize(420 * MB)).toBe('420 MB');
    expect(formatByteSize(180 * MB)).toBe('180 MB');
  });

  it('formats GB with one decimal', () => {
    expect(formatByteSize(2 * GB)).toBe('2.0 GB');
    expect(formatByteSize(1.5 * GB)).toBe('1.5 GB');
  });

  it('formats KB and bytes for small values', () => {
    expect(formatByteSize(4 * 1024)).toBe('4 KB');
    expect(formatByteSize(512)).toBe('512 B');
  });

  it('is defensive about non-finite / negative input', () => {
    expect(formatByteSize(-1)).toBe('0 MB');
    expect(formatByteSize(Number.NaN)).toBe('0 MB');
    expect(formatByteSize(0)).toBe('0 MB');
  });
});

describe('isOutOfSpaceMessage', () => {
  it('recognises the common out-of-space phrasings', () => {
    for (const m of [
      'write failed: ENOSPC: no space left on device',
      'No space left on device',
      'SQLITE_FULL: database or disk is full',
      'Not enough space to complete the operation',
      'Storage full',
      'Out of space',
    ]) {
      expect(isOutOfSpaceMessage(m)).toBe(true);
    }
  });

  it('does not flag unrelated failures', () => {
    for (const m of ['network error', 'tile limit exceeded', 'invalid zoom range', '']) {
      expect(isOutOfSpaceMessage(m)).toBe(false);
    }
  });
});
