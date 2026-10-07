import {
  applyLoopbackSignal,
  isServedTransportFailure,
  MAX_RESTARTS,
  needsProbe,
  PROBE_TIMEOUT_MS,
  rebaseServedUrl,
  recoveryAfterFailedProbe,
  RESTART_WINDOW_MS,
  REVERIFY_AFTER_MS,
  startedHealth,
  type LoopbackHealth,
  isExpectedServerDeath,
} from './loopbackLiveness';

describe('loopback liveness', () => {
  it('trusts a server that just started, until it has been idle a while', () => {
    const health = startedHealth(1_000);
    expect(needsProbe(health, 1_000)).toBe(false);
    expect(needsProbe(health, 1_000 + REVERIFY_AFTER_MS - 1)).toBe(false);
    expect(needsProbe(health, 1_000 + REVERIFY_AFTER_MS)).toBe(true);
  });

  it('suspects the server after a trip to the background, not before', () => {
    let health = startedHealth(0);
    health = applyLoopbackSignal(health, { kind: 'background' }, 10);
    // Still running in the background (e.g. a recording): no reason to doubt it yet.
    expect(needsProbe(health, 20)).toBe(false);
    // A second background signal keeps the first timestamp.
    health = applyLoopbackSignal(health, { kind: 'background' }, 15);
    expect(health.backgroundedAt).toBe(10);
    health = applyLoopbackSignal(health, { kind: 'foreground' }, 30);
    expect(health).toEqual({ verifiedAt: null, backgroundedAt: null, restarts: [] });
    expect(needsProbe(health, 30)).toBe(true);
  });

  it('ignores a foreground signal that was not preceded by a background one', () => {
    const health = startedHealth(0);
    expect(applyLoopbackSignal(health, { kind: 'foreground' }, 5)).toBe(health);
  });

  it('a probe or a served success proves it alive; a transport failure makes it suspect', () => {
    let health = applyLoopbackSignal(startedHealth(0), { kind: 'unreachable' }, 5);
    expect(needsProbe(health, 6)).toBe(true);
    health = applyLoopbackSignal(health, { kind: 'reachable' }, 7);
    expect(health.verifiedAt).toBe(7);
    expect(needsProbe(health, 8)).toBe(false);
  });

  it('restarts a dead server, but only a few times per window', () => {
    let health: LoopbackHealth = startedHealth(0);
    let now = 1_000;
    for (let i = 0; i < MAX_RESTARTS; i++) {
      expect(recoveryAfterFailedProbe(health, now)).toBe('restart');
      health = applyLoopbackSignal(health, { kind: 'restarted' }, now);
      expect(health.verifiedAt).toBe(now);
      now += 1_000;
    }
    expect(recoveryAfterFailedProbe(health, now)).toBe('give-up');
    // Once the oldest restart leaves the window, one more is allowed — and the
    // record forgets restarts outside the window.
    now = 1_000 + RESTART_WINDOW_MS;
    expect(recoveryAfterFailedProbe(health, now)).toBe('restart');
    health = applyLoopbackSignal(health, { kind: 'restarted' }, now);
    expect(health.restarts).toEqual([2_000, 3_000, now]);
  });

  it('keeps the probe short enough to hide behind a resume', () => {
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });
});

describe('isExpectedServerDeath (#582)', () => {
  it('is the iOS resume reclaim only', () => {
    expect(isExpectedServerDeath('resume', 'ios')).toBe(true);
  });

  it('keeps every other death reportable', () => {
    expect(isExpectedServerDeath('resume', 'android')).toBe(false);
    for (const reason of ['idle', 'transport', 'page-load'] as const) {
      expect(isExpectedServerDeath(reason, 'ios')).toBe(false);
    }
  });
});

describe('isServedTransportFailure', () => {
  it('recognises the field reports: a refused first request and a dropped transfer', () => {
    expect(
      isServedTransportFailure(
        'Load failed [served fetch: 1 requests, 1 failed; GET /maps/0BLT_9y1aqEr.pdf (0 B read) failed: Load failed]',
      ),
    ).toBe(true);
    expect(
      isServedTransportFailure(
        'Load failed [served fetch: 4 requests, 1 failed; GET /maps/big.pdf bytes=2097152-3145727 -> 206 (4096 B read) failed: Load failed]',
      ),
    ).toBe(true);
    expect(isServedTransportFailure('x [served fetch: 12 requests, 10 failed; …]')).toBe(true);
  });

  it('leaves page and engine failures alone', () => {
    expect(isServedTransportFailure('Unexpected server response (404) while retrieving PDF')).toBe(
      false,
    );
    expect(isServedTransportFailure('Invalid PDF structure')).toBe(false);
    expect(isServedTransportFailure('x [served fetch: 3 requests, 0 failed]')).toBe(false);
    expect(isServedTransportFailure('PdfRasterizer: render timed out after 45000ms')).toBe(false);
  });
});

describe('rebaseServedUrl', () => {
  it('moves a URL on the dead origin to the new one', () => {
    expect(
      rebaseServedUrl(
        'http://127.0.0.1:5000/maps/a%20b.pdf',
        'http://127.0.0.1:5000',
        'http://127.0.0.1:6000/',
      ),
    ).toBe('http://127.0.0.1:6000/maps/a%20b.pdf');
    expect(
      rebaseServedUrl('http://127.0.0.1:5000/maps/a.pdf', 'http://127.0.0.1:5000/', 'http://h:1'),
    ).toBe('http://h:1/maps/a.pdf');
  });

  it('leaves anything else untouched, including a longer port that shares the prefix', () => {
    expect(
      rebaseServedUrl('http://127.0.0.1:50001/maps/a.pdf', 'http://127.0.0.1:5000', 'http://x:1'),
    ).toBe('http://127.0.0.1:50001/maps/a.pdf');
    expect(rebaseServedUrl('file:///a.pdf', 'http://127.0.0.1:5000', 'http://x:1')).toBe(
      'file:///a.pdf',
    );
  });
});
