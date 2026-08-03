import { HEAT_CELL_M, cellAt, cellKey, ringKeys } from './grid';

describe('heat grid', () => {
  it('two points ~10 m apart share a cell; ~60 m apart do not', () => {
    // Mid-cell base: at 25 m cells this row spans lat 46.813915–46.814140,
    // so both points sit safely inside it (boundary-straddling data flaked).
    const a = cellAt(-71.2082, 46.814);
    const near = cellAt(-71.2082, 46.81404); // ~4.5 m north, same cell
    const far = cellAt(-71.2082, 46.8145); // ~56 m north
    expect(cellKey(near)).toBe(cellKey(a));
    expect(cellKey(far)).not.toBe(cellKey(a));
  });

  it('is deterministic: same input, same cell, regardless of call order', () => {
    const k1 = cellKey(cellAt(7.5, 60.0));
    const k2 = cellKey(cellAt(7.5, 60.0));
    expect(k1).toBe(k2);
  });

  it('cosine-corrects column width (lng degrees are shorter at high latitude)', () => {
    // 0.0005° lng ≈ 38 m at lat 46.8 (different col at 25 m cells)…
    const a = cellAt(-71.2082, 46.8139);
    const b = cellAt(-71.2077, 46.8139);
    expect(b.col).not.toBe(a.col);
    // …and the same lng delta at the equator is ~56 m: also different cols,
    // but MORE columns apart than at 46.8 would suggest without correction.
    const e1 = cellAt(0, 0.0001);
    const e2 = cellAt(0.0005, 0.0001);
    expect(Math.abs(e2.col - e1.col)).toBeGreaterThanOrEqual(2);
  });

  it('ringKeys returns 9 unique keys including the centre', () => {
    const c = cellAt(-71.2082, 46.8139);
    const ring = ringKeys(c);
    expect(ring).toHaveLength(9);
    expect(new Set(ring).size).toBe(9);
    expect(ring).toContain(cellKey(c));
  });

  it('honours a custom cell size', () => {
    const coarseA = cellAt(-71.2082, 46.8139, 250);
    const coarseB = cellAt(-71.2082, 46.8145, 250); // ~67 m north
    expect(cellKey(coarseA)).toBe(cellKey(coarseB));
    expect(HEAT_CELL_M).toBe(25);
  });
});
