import { metersPerPixel, niceBelow, scaleBar } from './scaleBar';

describe('metersPerPixel', () => {
  it('matches the Web-Mercator reference value at the equator', () => {
    // 40075016.686 / 512 = 78271.5169… m per pixel at zoom 0, latitude 0.
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.517, 2);
    expect(metersPerPixel(10, 0)).toBeCloseTo(78271.517 / 1024, 4);
  });

  it('shrinks with cos(latitude) — the whole reason the bar is latitude-aware', () => {
    const equator = metersPerPixel(12, 0) ?? 0;
    const sixty = metersPerPixel(12, 60) ?? 0;
    const high = metersPerPixel(12, 83) ?? 0;
    expect(sixty / equator).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 6);
    // 83°N — the top of the map sheets this app ships — is ~8× finer.
    expect(equator / high).toBeGreaterThan(8);
  });

  it('is symmetric about the equator', () => {
    expect(metersPerPixel(9, 46.8)).toBeCloseTo(metersPerPixel(9, -46.8) ?? 0, 9);
  });

  it('clamps beyond the Mercator domain instead of collapsing to zero', () => {
    expect(metersPerPixel(8, 89.999)).toBe(metersPerPixel(8, 85));
    expect(metersPerPixel(8, -120)).toBe(metersPerPixel(8, -85));
  });

  it('rejects non-finite camera state', () => {
    expect(metersPerPixel(Number.NaN, 0)).toBeNull();
    expect(metersPerPixel(10, Number.POSITIVE_INFINITY)).toBeNull();
    // A zoom big enough to underflow to 0 m/px has no drawable scale.
    expect(metersPerPixel(2000, 0)).toBeNull();
  });
});

describe('niceBelow', () => {
  it('snaps down to 1/2/5 x 10^n', () => {
    expect(niceBelow(1)).toBe(1);
    expect(niceBelow(1.9)).toBe(1);
    expect(niceBelow(2)).toBe(2);
    expect(niceBelow(4.99)).toBe(2);
    expect(niceBelow(5)).toBe(5);
    expect(niceBelow(9.99)).toBe(5);
    expect(niceBelow(437)).toBe(200);
    expect(niceBelow(1000)).toBe(1000);
    expect(niceBelow(0.7)).toBe(0.5);
  });

  it('returns 0 for junk', () => {
    expect(niceBelow(0)).toBe(0);
    expect(niceBelow(-5)).toBe(0);
    expect(niceBelow(Number.NaN)).toBe(0);
  });
});

describe('scaleBar', () => {
  it('never exceeds the allotted width and always labels a round distance', () => {
    for (let zoom = 3; zoom <= 20; zoom++) {
      for (const lat of [0, 46.8, 60, 83]) {
        for (const units of ['metric', 'imperial'] as const) {
          const bar = scaleBar(zoom, lat, 110, units);
          expect(bar).not.toBeNull();
          if (!bar) continue;
          expect(bar.widthPx).toBeGreaterThan(0);
          expect(bar.widthPx).toBeLessThanOrEqual(110);
          expect(bar.label).toMatch(/^\d+(\.\d+)? (m|km|ft|mi)$/);
          const [magnitude] = bar.label.split(' ');
          expect(niceBelow(Number(magnitude))).toBe(Number(magnitude));
        }
      }
    }
  });

  it('honours the unit system for the same camera', () => {
    // 200 px at z13, 46.8°N ≈ 1308 m of allowance.
    const metric = scaleBar(13, 46.8, 200, 'metric');
    expect(metric).toEqual({ meters: 1000, widthPx: expect.any(Number), label: '1 km' });
    const imperial = scaleBar(13, 46.8, 200, 'imperial');
    // 1308 m ≈ 4292 ft, still short of a mile — so feet, rounded down to 2000.
    expect(imperial?.label).toBe('2000 ft');
    expect(imperial?.meters).toBeCloseTo(609.6, 6);
    // Both bars describe the same map, so a shorter distance draws a shorter bar.
    expect(imperial?.widthPx).toBeLessThan(metric?.widthPx ?? 0);
  });

  it('switches metric from metres to kilometres at 1 km', () => {
    const mpp = metersPerPixel(15, 0) ?? 0;
    // Exactly 1 km of allowance -> a 1 km bar.
    expect(scaleBar(15, 0, 1000 / mpp, 'metric')?.label).toBe('1 km');
    // A hair under -> the largest nice value below 1 km.
    expect(scaleBar(15, 0, 999 / mpp, 'metric')?.label).toBe('500 m');
  });

  it('switches imperial from feet to miles at one mile', () => {
    const mpp = metersPerPixel(15, 0) ?? 0;
    const mile = 5280 * 0.3048;
    expect(scaleBar(15, 0, mile / mpp, 'imperial')?.label).toBe('1 mi');
    expect(scaleBar(15, 0, (mile - 1) / mpp, 'imperial')?.label).toBe('5000 ft');
  });

  it('draws a shorter bar the further north you are, at the same zoom', () => {
    const south = scaleBar(11, 0, 110, 'metric');
    const north = scaleBar(11, 75, 110, 'metric');
    expect(north?.meters).toBeLessThan(south?.meters ?? 0);
  });

  it('returns null for junk geometry', () => {
    expect(scaleBar(12, 46, 0, 'metric')).toBeNull();
    expect(scaleBar(12, 46, -10, 'metric')).toBeNull();
    expect(scaleBar(12, 46, Number.NaN, 'metric')).toBeNull();
    expect(scaleBar(Number.NaN, 46, 110, 'metric')).toBeNull();
    // Absurdly deep zoom: even the smallest nice distance is sub-pixel.
    expect(scaleBar(2000, 46, 110, 'metric')).toBeNull();
  });
});
