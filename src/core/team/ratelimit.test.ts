import { categoryOf, LAN_LIMITS, PeerGuard, RELAY_LIMITS, TokenBucket } from './ratelimit';

describe('TokenBucket', () => {
  it('spends a burst, then refills at the rate, never above the burst', () => {
    const b = new TokenBucket(10, 5);
    for (let i = 0; i < 5; i++) expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(false);
    expect(b.take(1, 100)).toBe(true); // +1 after 100 ms
    expect(b.take(1, 100)).toBe(false);
    expect(b.take(5, 10_000)).toBe(true); // refilled to the burst only
    expect(b.take(1, 10_000)).toBe(false);
    expect(b.take(1, 5_000)).toBe(false); // a clock going backwards refills nothing
  });
});

describe('PeerGuard', () => {
  it('refuses oversize frames before rate accounting', () => {
    const g = new PeerGuard(RELAY_LIMITS);
    expect(g.admitFrame(RELAY_LIMITS.maxFrameBytes + 1, 0)).toBe('oversize');
    expect(g.admitFrame(100, 0)).toBe('ok');
  });

  it('rate-limits frames and bytes', () => {
    const g = new PeerGuard({ ...LAN_LIMITS, burstFrames: 2, framesPerSec: 1 });
    expect(g.admitFrame(10, 0)).toBe('ok');
    expect(g.admitFrame(10, 0)).toBe('ok');
    expect(g.admitFrame(10, 0)).toBe('rate');
    const bytes = new PeerGuard({ ...LAN_LIMITS, burstBytes: 100, bytesPerSec: 1 });
    expect(bytes.admitFrame(90, 0)).toBe('ok');
    expect(bytes.admitFrame(20, 0)).toBe('rate');
  });

  it('caps unsolicited ops per category', () => {
    const g = new PeerGuard(RELAY_LIMITS);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (g.admitOp('control', 0)) ok++;
    expect(ok).toBe(RELAY_LIMITS.ops.control[1]);
    expect(g.admitOp('pos', 0)).toBe(true);
  });

  it('bans after enough strikes inside the window, and the ban expires', () => {
    const g = new PeerGuard({ ...LAN_LIMITS, strikesToBan: 3, strikeWindowMs: 1000, banMs: 5000 });
    expect(g.strike(0)).toBe(false);
    expect(g.strike(2000)).toBe(false); // the first one aged out
    expect(g.strike(2100)).toBe(false);
    expect(g.strike(2200)).toBe(true);
    expect(g.isBanned(3000)).toBe(true);
    expect(g.isBanned(8000)).toBe(false);
  });

  it('categorises op types', () => {
    expect(categoryOf('pos')).toBe('pos');
    expect(categoryOf('msg')).toBe('msg');
    expect(categoryOf('e.set')).toBe('data');
    expect(categoryOf('m.add')).toBe('control');
    expect(categoryOf('???')).toBe('control');
  });
});
