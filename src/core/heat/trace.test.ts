import { cellAt, cellKey } from './grid';
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
