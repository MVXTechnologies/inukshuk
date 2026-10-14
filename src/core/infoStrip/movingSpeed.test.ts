import {
  createMovingSpeedWindow,
  MOVING_MAX_GAP_MS,
  MOVING_WARMUP_MS,
  MOVING_WINDOW_MS,
} from './movingSpeed';

/** A point `m` metres north of the origin (1° of latitude ≈ 111 195 m on the haversine sphere). */
const M_PER_DEG = (Math.PI / 180) * 6371008.8;
const north = (m: number) => ({ latitude: 46 + m / M_PER_DEG, longitude: -71 });

describe('moving speed window', () => {
  it('stays silent through the 2-minute warm-up', () => {
    const w = createMovingSpeedWindow();
    expect(w.speedMps(0)).toBeNull();
    for (let s = 0; s <= 100; s++) w.push(north(s * 1.2), s * 1000);
    expect(w.speedMps(100_000)).toBeNull();
    for (let s = 101; s <= 130; s++) w.push(north(s * 1.2), s * 1000);
    expect(w.speedMps(130_000)).toBeCloseTo(1.2, 3);
    expect(MOVING_WARMUP_MS).toBe(120_000);
  });

  it('leaves stops out: a 5-minute break does not slow the estimate', () => {
    const w = createMovingSpeedWindow();
    let t = 0;
    let m = 0;
    for (; t <= 180; t++) w.push(north((m = t * 1.5)), t * 1000);
    // Standing still (GPS jitter under 0.3 m/s) for 5 minutes.
    for (let i = 1; i <= 300; i++) w.push(north(m + (i % 2) * 0.2), (t + i) * 1000);
    expect(w.speedMps((t + 300) * 1000)).toBeCloseTo(1.5, 3);
  });

  it('forgets segments older than 10 minutes', () => {
    const w = createMovingSpeedWindow();
    // 10 minutes at 3 m/s, then 10 minutes at 1 m/s.
    let m = 0;
    for (let s = 1; s <= 600; s++) w.push(north((m += 3)), s * 1000);
    for (let s = 601; s <= 1200; s++) w.push(north((m += 1)), s * 1000);
    expect(w.speedMps(1_200_000)).toBeCloseTo(1, 3);
    // Ten more minutes with no fix: everything left the window.
    expect(w.speedMps(1_200_000 + MOVING_WINDOW_MS)).toBeNull();
  });

  it('ignores a gap (signal lost) and out-of-order fixes', () => {
    const w = createMovingSpeedWindow();
    w.push(north(0), 0);
    w.push(north(1000), MOVING_MAX_GAP_MS + 1); // not a segment: too long a gap
    w.push(north(1000), 1000); // older than the last: ignored
    for (let s = 1; s <= 150; s++) w.push(north(1000 + s), MOVING_MAX_GAP_MS + 1 + s * 1000);
    expect(w.speedMps(MOVING_MAX_GAP_MS + 151_000)).toBeCloseTo(1, 3);
  });

  it('resets', () => {
    const w = createMovingSpeedWindow();
    for (let s = 0; s <= 200; s++) w.push(north(s), s * 1000);
    w.reset();
    expect(w.speedMps(200_000)).toBeNull();
    w.push(north(0), 300_000);
    expect(w.speedMps(500_000)).toBeNull(); // warm, but nothing moved
  });

  it('does constant work per fix: the dead prefix is compacted', () => {
    const w = createMovingSpeedWindow();
    let m = 0;
    // Three hours at 1 Hz: memory stays bounded by the window, speed stays exact.
    for (let s = 1; s <= 3 * 3600; s++) w.push(north((m += 2)), s * 1000);
    expect(w.speedMps(3 * 3600 * 1000)).toBeCloseTo(2, 3);
  });

  describe("the fixes' own times and accuracy (jitter)", () => {
    it('jumps inside the accuracy radii while standing add nothing', () => {
      const w = createMovingSpeedWindow();
      let m = 0;
      let t = 0;
      // Three minutes at 1.5 m/s, ±4 m fixes.
      for (; t <= 180; t++) w.push(north((m = t * 1.5)), t * 1000, 4);
      // Five minutes standing, ±8 m fixes scattered within it: fix to fix they
      // jump up to 14.5 m in a second (14.5 m/s "moves").
      for (let i = 1; i <= 300; i++) {
        const jump = [0, 7, -7, 5, -7.5, 4][i % 6]!;
        w.push(north(m + jump), (t + i) * 1000, 8);
      }
      expect(w.speedMps((t + 300) * 1000)).toBeCloseTo(1.5, 2);
    });

    it('without accuracy the same jumps would be counted (what the radii guard)', () => {
      const w = createMovingSpeedWindow();
      let m = 0;
      let t = 0;
      for (; t <= 180; t++) w.push(north((m = t * 1.5)), t * 1000);
      for (let i = 1; i <= 300; i++) {
        const jump = [0, 7, -7, 5, -7.5, 4][i % 6]!;
        w.push(north(m + jump), (t + i) * 1000);
      }
      expect(w.speedMps((t + 300) * 1000)!).toBeGreaterThan(2);
    });

    it('a slow walk with poor accuracy still counts: the anchor waits until you leave it', () => {
      const w = createMovingSpeedWindow();
      // 0.8 m/s, a fix each second, ±10 m: no single step clears 20 m, the walk does.
      for (let s = 0; s <= 600; s++) w.push(north(s * 0.8), s * 1000, 10);
      expect(w.speedMps(600_000)).toBeCloseTo(0.8, 2);
    });

    it('a fix delivered late is timed by its own timestamp', () => {
      const w = createMovingSpeedWindow();
      // 1 m/s by the fixes' own times, whatever the UI's clock said on delivery.
      for (let s = 0; s <= 200; s++) w.push(north(s), s * 1000, 3);
      expect(w.speedMps(200_000)).toBeCloseTo(1, 3);
      // An out-of-order or invalid timestamp is ignored.
      w.push(north(10_000), 150_000, 3);
      w.push(north(10_000), Number.NaN, 3);
      expect(w.speedMps(200_000)).toBeCloseTo(1, 3);
    });
  });
});
