import { recordingElapsedS } from './elapsed';

describe('recordingElapsedS', () => {
  it('counts wall time since the start, minus completed pauses', () => {
    expect(recordingElapsedS({ startedAt: 0, pausedMs: 0, pausedAt: null, now: 61_900 })).toBe(61);
    expect(recordingElapsedS({ startedAt: 0, pausedMs: 30_000, pausedAt: null, now: 90_000 })).toBe(
      60,
    );
  });

  it('freezes at the pause start while paused, however late it is read (#325)', () => {
    // Recorded 57 s, paused, app killed; relaunched an hour later.
    const args = { startedAt: 1_000, pausedMs: 0, pausedAt: 58_000 };
    expect(recordingElapsedS({ ...args, now: 58_000 })).toBe(57);
    expect(recordingElapsedS({ ...args, now: 58_000 + 3_600_000 })).toBe(57);
  });

  it('never goes negative on a clock that stepped backwards', () => {
    expect(recordingElapsedS({ startedAt: 10_000, pausedMs: 0, pausedAt: null, now: 0 })).toBe(0);
  });
});
