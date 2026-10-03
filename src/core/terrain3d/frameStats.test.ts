import { costStats, frameIntervals, frameStats, percentile } from './frameStats';
import { packLook, PACKED_LOOK_LENGTH, terrainLook } from './look';

const ns = (ms: number[]) => {
  let t = 0;
  return [0, ...ms.map((m) => (t += m * 1e6))];
};

describe('percentile', () => {
  it.each([
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50, 5],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95, 10],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0, 1],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 100, 10],
    [[7], 99, 7],
    [[], 50, 0],
  ])('%j p%p = %p', (a, p, v) => {
    expect(percentile(a, p)).toBe(v);
  });
});

describe('frameStats', () => {
  it('a perfect 60 Hz run', () => {
    const s = frameStats(ns(Array(120).fill(1000 / 60)));
    expect(s.frames).toBe(120);
    expect(s.medianMs).toBeCloseTo(16.667, 2);
    expect(s.over16Pct).toBe(0);
    expect(s.over33Pct).toBe(0);
    expect(s.fps).toBeCloseTo(60, 6);
  });

  it('counts missed vsyncs, tolerating jitter', () => {
    const run = [...Array(90).fill(16.9), ...Array(8).fill(33.4), 50.1, 50.1];
    const s = frameStats(ns(run));
    expect(s.frames).toBe(100);
    expect(s.over16Pct).toBe(10);
    expect(s.over33Pct).toBe(2);
    expect(s.worstMs).toBeCloseTo(50.1, 6);
    expect(s.p95Ms).toBeCloseTo(33.4, 6);
  });

  it('drops idle gaps between script steps', () => {
    const run = [16.7, 16.7, 600, 16.7, 16.7, 1200];
    const { intervals, idleGaps } = frameIntervals(ns(run));
    expect(idleGaps).toBe(2);
    expect(intervals).toHaveLength(4);
    expect(frameStats(ns(run)).worstMs).toBeCloseTo(16.7, 6);
  });

  it('ignores duplicate or backwards timestamps', () => {
    expect(frameIntervals([0, 0, 16e6, 10e6, 30e6]).intervals).toEqual([16, 20]);
  });

  it('empty input is all zeros', () => {
    expect(frameStats([])).toEqual({
      frames: 0,
      medianMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      worstMs: 0,
      over16Pct: 0,
      over33Pct: 0,
      fps: 0,
      idleGaps: 0,
    });
  });

  it('cost stats in ms', () => {
    expect(costStats([1e6, 2e6, 3e6, 10e6])).toEqual({ medianMs: 2, p95Ms: 10, worstMs: 10 });
    expect(costStats([])).toEqual({ medianMs: 0, p95Ms: 0, worstMs: 0 });
  });
});

describe('packLook', () => {
  it('packs 40 floats in the native order', () => {
    const l = terrainLook({ basemap: 'map', dark: false, land: '#F2ECE0', relief: 'dramatic' });
    const p = packLook(l);
    expect(p).toHaveLength(PACKED_LOOK_LENGTH);
    expect(p[0]).toBe(l.exaggeration);
    expect(p.slice(1, 4)).toEqual(l.fogColor);
    expect(p.slice(4, 7)).toEqual(l.skyHorizon);
    expect(p.slice(7, 10)).toEqual(l.skyZenith);
    expect(p.slice(10, 14)).toEqual([l.formStrength, l.fogStartCtc, l.fogDensity, l.fogEndCtc]);
    expect(p.slice(14, 17)).toEqual(l.surface.land);
    expect(p.slice(29, 32)).toEqual(l.surface.highlight);
    expect(p.slice(32, 35)).toEqual(l.contourColor);
    expect(p.slice(35, 38)).toEqual(l.contourMajorColor);
    expect(p[38]).toBe(l.contourOpacity);
    expect(p[39]).toBe(l.imagery);
    for (const v of p) expect(Number.isFinite(v)).toBe(true);
  });
});
