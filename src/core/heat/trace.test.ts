import { cellAt, cellKey } from './grid';
import * as grid from './grid';
import { traceCells } from './trace';

const pt = (lng: number, lat: number) => ({ longitude: lng, latitude: lat });

describe('traceCells', () => {
  it('perPoint has one key per input point', () => {
    const points = [pt(-71.2082, 46.8139), pt(-71.208, 46.814), pt(-71.2078, 46.8141)];
    const trace = traceCells(points);
    expect(trace.perPoint).toHaveLength(3);
    expect(trace.perPoint[0]).toBe(cellKey(cellAt(-71.2082, 46.8139)));
  });

  it('interpolates long segments: a 200 m hop leaves no cell gaps', () => {
    // ~200 m north in one segment; must touch every ~25 m row between.
    const trace = traceCells([pt(-71.2082, 46.8139), pt(-71.2082, 46.8157)]);
    const rows = new Set([...trace.dilated].map((k) => Number(k.split(',')[0])));
    const min = Math.min(...rows);
    const max = Math.max(...rows);
    for (let r = min; r <= max; r++) expect(rows.has(r)).toBe(true);
  });

  it('dilation: parallel traces ~20 m apart share cells; ~80 m apart do not', () => {
    // 0.00018° lat ≈ 20 m; 0.00072° ≈ 80 m.
    const line = (latOffset: number) => [
      pt(-71.2082, 46.8139 + latOffset),
      pt(-71.2075, 46.8139 + latOffset),
    ];
    const a = traceCells(line(0));
    const near = traceCells(line(0.00018));
    const far = traceCells(line(0.00072));
    const overlaps = (x: Set<string>, y: Set<string>) => [...x].some((k) => y.has(k));
    expect(overlaps(a.dilated, near.dilated)).toBe(true);
    expect(overlaps(a.dilated, far.dilated)).toBe(false);
  });

  it('handles empty and single-point inputs', () => {
    expect(traceCells([]).perPoint).toHaveLength(0);
    expect(traceCells([]).dilated.size).toBe(0);
    const single = traceCells([pt(-71.2082, 46.8139)]);
    expect(single.perPoint).toHaveLength(1);
    expect(single.dilated.size).toBe(9); // the cell + its ring
  });
});

describe('traceCells work bounds', () => {
  it('crosses the dateline locally instead of filling cells around the globe', () => {
    const trace = traceCells([pt(179.999, 0), pt(-179.999, 0)], 1000);
    expect(trace.dilated.size).toBeLessThan(30);
    expect(trace.dilated.has(cellKey(cellAt(0, 0, 1000)))).toBe(false);
  });

  it.each([1, -1])('normalizes intermediate dateline samples in direction %s', (direction) => {
    const trace = traceCells([pt(direction * 179.99, 0), pt(direction * -179.99, 0)], 250);
    expect(trace.dilated.size).toBeLessThan(100);
    expect(trace.dilated.has(cellKey(cellAt(179.995, 0, 250)))).toBe(true);
    expect(trace.dilated.has(cellKey(cellAt(-179.995, 0, 250)))).toBe(true);
    expect(trace.dilated.has(cellKey(cellAt(0, 0)))).toBe(false);
  });

  it('keeps endpoints but does not fill implausibly long segments', () => {
    const trace = traceCells([pt(0, 0), pt(20, 0)], 1000);
    expect(trace.dilated.size).toBe(18);
    expect(trace.perPoint).toHaveLength(2);
  });

  it('bounds interpolation across the whole track while preserving every input fix', () => {
    const points = Array.from({ length: 40 }, (_, i) => pt(i % 2, i / 100));
    const stamp = jest.spyOn(grid, 'ringKeys');
    try {
      const trace = traceCells(points, 200);
      expect(trace.perPoint).toHaveLength(points.length);
      expect(stamp.mock.calls.length).toBeLessThanOrEqual(points.length + 20000);
      expect(trace.dilated.has(trace.perPoint.at(-1) ?? '')).toBe(true);
    } finally {
      stamp.mockRestore();
    }
  });

  it('samples oversized tracks deterministically, retaining first and last fixes', () => {
    const points = Array.from({ length: 100001 }, (_, i) => pt(i / 100000, 0));
    const stamp = jest.spyOn(grid, 'ringKeys');
    try {
      const trace = traceCells(points);
      expect(trace.perPoint).toHaveLength(100000);
      expect(stamp.mock.calls.length).toBeLessThanOrEqual(120000);
      expect(trace.perPoint[0]).toBe(cellKey(cellAt(0, 0)));
      expect(trace.perPoint.at(-1)).toBe(cellKey(cellAt(1, 0)));
      expect(trace.dilated.has(cellKey(cellAt(1, 0)))).toBe(true);
      expect(traceCells(points).perPoint).toEqual(trace.perPoint);
      expect(points).toHaveLength(100001);
    } finally {
      stamp.mockRestore();
    }
  });

  it.each([0, -1, NaN, Infinity, Number.MIN_VALUE])('rejects unsafe cell size %s', (size) => {
    expect(() => traceCells([], size)).toThrow(RangeError);
  });

  it.each([pt(Infinity, 0), pt(0, NaN), pt(181, 0), pt(0, -91)])(
    'rejects invalid coordinates %s',
    (point) => {
      expect(() => traceCells([point])).toThrow(RangeError);
    },
  );
});

it('uses the custom grid size when stamping dateline neighbors', () => {
  const trace = traceCells([pt(179.99999, 75)], 250);
  expect(trace.dilated.has(cellKey(cellAt(-179.99999, 75, 250)))).toBe(true);
});
