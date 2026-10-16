import {
  GROUP_SPAN,
  TERRAIN_LINE_GROUPS,
  groupBase,
  groupLines,
  groupOfId,
  ringAsLine,
} from './lineGroups';
import type { LineStyleInput } from './sceneInput';

const style: LineStyleInput = {
  color: '#c2410c',
  halo: '#ffffff',
  haloOpacity: 0.9,
  width: 3,
  haloAdd: 3,
  order: 0,
};
const line = (n: number, x0 = 7.7) => ({
  type: 'LineString' as const,
  coordinates: Array.from({ length: n }, (_, i) => [x0 + i * 0.001, 46 + i * 0.001]),
});

describe('terrain line groups (#735)', () => {
  it('gives every overlay its own id range, none overlapping legacy group 0', () => {
    const bases = TERRAIN_LINE_GROUPS.map(groupBase);
    expect(new Set(bases).size).toBe(TERRAIN_LINE_GROUPS.length);
    for (const b of bases) expect(b).toBeGreaterThanOrEqual(GROUP_SPAN);
    for (const g of TERRAIN_LINE_GROUPS) {
      expect(groupOfId(groupBase(g))).toBe(g);
      expect(groupOfId(groupBase(g) + GROUP_SPAN - 1)).toBe(g);
    }
    expect(groupOfId(5)).toBeNull();
    // Ids stay inside a 32-bit int (the native line id).
    expect(
      groupBase(TERRAIN_LINE_GROUPS[TERRAIN_LINE_GROUPS.length - 1]!) + GROUP_SPAN,
    ).toBeLessThan(2 ** 31);
  });

  it('packs one spec per part with stable ids in the group range', () => {
    const lines = groupLines(
      'teamDrawings',
      [
        { geometry: line(3), color: '#ff0000', width: 6 },
        {
          geometry: {
            type: 'MultiLineString',
            coordinates: [line(2).coordinates, line(4, 8).coordinates],
          },
        },
        { geometry: line(1) }, // a single point: no line
      ],
      style,
    );
    const base = groupBase('teamDrawings');
    expect(lines.map((l) => l.id)).toEqual([base, base + 1, base + 2]);
    expect(lines.every((l) => groupOfId(l.id) === 'teamDrawings')).toBe(true);
    // Per-feature colour and width; the style's otherwise.
    expect(lines[0]?.style.slice(0, 3)).toEqual([1, 0, 0]);
    expect(lines[0]?.style[8]).toBe(6);
    expect(lines[1]?.style[8]).toBe(3);
    expect(lines[0]?.coords).toEqual(line(3).coordinates.flat());
    // Same features, same ids: a re-send replaces in place.
    const again = groupLines(
      'teamDrawings',
      [{ geometry: line(3), color: '#ff0000', width: 6 }],
      style,
    );
    expect(again[0]?.id).toBe(base);
  });

  it('orders groups as listed, and carries opacity and halo overrides', () => {
    const [trail] = groupLines('trails', [{ geometry: line(2) }], { ...style, order: 2 });
    const [rec] = groupLines('recording', [{ geometry: line(2) }], style);
    const [faded] = groupLines(
      'teamDrawings',
      [{ geometry: line(2), opacity: 0.5, halo: '#000000', haloAdd: 14 }],
      style,
    );
    // style: [r, g, b, a, hr, hg, hb, ha, width, haloWidth, order]
    expect(trail?.style[10]).toBe(12);
    expect(rec?.style[10]).toBeGreaterThan(trail?.style[10] ?? Infinity);
    expect(faded?.style[3]).toBe(0.5);
    expect(faded?.style[7]).toBeCloseTo(0.45);
    expect(faded?.style.slice(4, 7)).toEqual([0, 0, 0]);
    expect(faded?.style[9]).toBe(3 + 14);
  });

  it('closes an area ring as a line', () => {
    expect(
      ringAsLine([
        [0, 0],
        [1, 0],
        [1, 1],
      ]).coordinates,
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
    expect(
      ringAsLine([
        [0, 0],
        [1, 0],
        [0, 0],
      ]).coordinates,
    ).toHaveLength(3);
  });
});
