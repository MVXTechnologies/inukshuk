import {
  MAX_LINE_POINTS,
  flattenPart,
  lineParts,
  nameFieldsFor,
  packLabelTheme,
  packLineStyle,
  sceneLines,
} from './sceneInput';

const style = {
  color: '#ff0000',
  halo: '#ffffff',
  haloOpacity: 0.75,
  width: 3,
  haloAdd: 2,
  order: 1,
};

describe('lineParts', () => {
  it('keeps a line string whole', () => {
    expect(
      lineParts({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toHaveLength(1);
  });
  it('splits a multi line string and drops one-point parts', () => {
    const parts = lineParts({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [[2, 2]],
        [
          [3, 3],
          [4, 4],
          [5, 5],
        ],
      ],
    });
    expect(parts.map((p) => p.length)).toEqual([2, 3]);
  });
  it('drops a degenerate line string', () => {
    expect(lineParts({ type: 'LineString', coordinates: [[0, 0]] })).toEqual([]);
  });
});

describe('flattenPart', () => {
  it('flattens lng/lat pairs and ignores elevation', () => {
    expect(
      flattenPart([
        [1, 2, 300],
        [3, 4, 310],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });
  it('skips non-finite points', () => {
    expect(
      flattenPart([
        [1, 2],
        [NaN, 4],
        [5, 6],
      ]),
    ).toEqual([1, 2, 5, 6]);
  });
  it('decimates long lines but keeps both ends', () => {
    const part = Array.from({ length: 10_001 }, (_, i) => [i, i]);
    const flat = flattenPart(part);
    expect(flat.length / 2).toBeLessThanOrEqual(MAX_LINE_POINTS + 1);
    expect(flat.slice(0, 2)).toEqual([0, 0]);
    expect(flat.slice(-2)).toEqual([10_000, 10_000]);
  });
  it('honours a custom cap', () => {
    const part = Array.from({ length: 100 }, (_, i) => [i, 0]);
    const flat = flattenPart(part, 10);
    expect(flat.length / 2).toBeLessThanOrEqual(11);
    expect(flat.slice(-2)).toEqual([99, 0]);
  });
  it('does not repeat the last point when it already landed on the step', () => {
    const part = Array.from({ length: 21 }, (_, i) => [i, 0]);
    const flat = flattenPart(part, 10);
    expect(flat.slice(-4)).not.toEqual([20, 0, 20, 0]);
    expect(flat.slice(-2)).toEqual([20, 0]);
  });
});

describe('packLineStyle', () => {
  it('packs colour, halo, widths and order', () => {
    expect(packLineStyle(style)).toEqual([1, 0, 0, 1, 1, 1, 1, 0.75, 3, 5, 1]);
  });
  it('falls back on unparseable colours', () => {
    const p = packLineStyle({ ...style, color: 'nope', halo: 'nope' });
    expect(p).toHaveLength(11);
    expect(p.slice(4, 7)).toEqual([1, 1, 1]);
    expect(p[0]).toBeGreaterThan(0.5);
  });
});

describe('sceneLines', () => {
  it('numbers parts from the base and colours per feature', () => {
    const lines = sceneLines(
      [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          color: '#00ff00',
        },
        {
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [0, 0],
                [1, 1],
              ],
              [
                [2, 2],
                [3, 3],
              ],
            ],
          },
          color: null,
        },
      ],
      style,
      1000,
    );
    expect(lines.map((l) => l.id)).toEqual([1000, 1001, 1002]);
    expect(lines[0]?.style.slice(0, 3)).toEqual([0, 1, 0]);
    expect(lines[1]?.style.slice(0, 3)).toEqual([1, 0, 0]);
  });
  it('skips lines that end up with fewer than two points', () => {
    const lines = sceneLines(
      [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [NaN, 1],
            ],
          },
        },
      ],
      style,
      0,
    );
    expect(lines).toEqual([]);
  });
});

describe('packLabelTheme', () => {
  it('packs 13 floats', () => {
    const t = packLabelTheme({
      plate: '#ffffff',
      plateOpacity: 0.9,
      ink: '#000000',
      muted: '#808080',
      water: '#0000ff',
    });
    expect(t).toHaveLength(13);
    expect(t.slice(0, 4)).toEqual([1, 1, 1, 0.9]);
    expect(t.slice(4, 7)).toEqual([0, 0, 0]);
    expect(t.slice(10, 13)).toEqual([0, 0, 1]);
  });
  it('falls back per colour', () => {
    const t = packLabelTheme({ plate: 'x', plateOpacity: 1, ink: 'x', muted: 'x', water: 'x' });
    expect(t).toHaveLength(13);
    expect(t.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('nameFieldsFor', () => {
  it('prefers the language then the local name', () => {
    expect(nameFieldsFor('fr')).toEqual(['name:fr', 'name']);
    expect(nameFieldsFor('en')).toEqual(['name:en', 'name']);
    expect(nameFieldsFor('local')).toEqual(['name']);
    expect(nameFieldsFor(undefined)).toEqual(['name']);
  });
});
