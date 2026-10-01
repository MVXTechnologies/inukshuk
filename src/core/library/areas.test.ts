import type { Area } from '@core/models';

import {
  AREA_COLORS,
  areaAt,
  areaSummaryLine,
  DEFAULT_AREA_COLOR,
  formatAreaSize,
  MAX_TAGS,
  nextAreaName,
  normalizeArea,
  normalizeTags,
  parseTagInput,
  sortAreasNewestFirst,
} from './areas';

const RING: Area['ring'] = [
  [-71.2, 46.8],
  [-71.19, 46.8],
  [-71.19, 46.81],
];

describe('normalizeArea', () => {
  it('keeps a well-formed area', () => {
    const a: Area = {
      id: 'a1',
      name: 'Slope',
      ring: RING,
      color: '#3E8E5A',
      note: 'n',
      photoUris: ['file:///p.jpg'],
      tags: ['Berries'],
      folderId: 'f1',
      createdAt: 5,
      updatedAt: 6,
    };
    expect(normalizeArea(a)).toEqual(a);
  });

  it('drops what cannot be drawn', () => {
    expect(normalizeArea(null)).toBeNull();
    expect(normalizeArea([])).toBeNull();
    expect(normalizeArea({ ring: RING })).toBeNull();
    expect(normalizeArea({ id: 'a', ring: RING.slice(0, 2) })).toBeNull();
  });

  it('cleans junk optional fields without losing the area', () => {
    expect(
      normalizeArea({
        id: 'a',
        name: '  ',
        ring: [...RING, ['x', 1]],
        color: 'red',
        note: 7,
        photoUris: ['', 3, 'file:///ok.jpg'],
        tags: ['  Berries ', 'berries', '', 4],
        createdAt: 'yesterday',
      }),
    ).toEqual({
      id: 'a',
      name: 'Area',
      ring: RING,
      color: DEFAULT_AREA_COLOR,
      photoUris: ['file:///ok.jpg'],
      tags: ['Berries'],
      createdAt: 0,
    });
  });
});

describe('tags', () => {
  it('normalizeTags trims, collapses spaces, dedupes and bounds', () => {
    expect(normalizeTags([' Private  notes ', 'PRIVATE NOTES', 'x'.repeat(40)])).toEqual([
      'Private notes',
      'x'.repeat(24),
    ]);
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
  });

  it('parseTagInput splits on commas, semicolons and new lines', () => {
    expect(parseTagInput('Berries, private;\nwater')).toEqual(['Berries', 'private', 'water']);
  });
});

describe('nextAreaName', () => {
  it('numbers past the highest auto name', () => {
    expect(nextAreaName([])).toBe('Area 1');
    expect(nextAreaName(['Area 1', 'Area 4', 'Blueberry slope'])).toBe('Area 5');
  });
});

describe('formatAreaSize', () => {
  it('metric: m², ha, km²', () => {
    expect(formatAreaSize(850, 'metric')).toBe('850 m²');
    expect(formatAreaSize(42_000, 'metric')).toBe('4.2 ha');
    expect(formatAreaSize(420_000, 'metric')).toBe('0.42 km²');
    expect(formatAreaSize(12_345_000, 'metric')).toBe('12.3 km²');
    expect(formatAreaSize(Number.NaN, 'metric')).toBe('0 m²');
  });

  it('imperial: ft², acres, mi²', () => {
    expect(formatAreaSize(100, 'imperial')).toBe('1,076 ft²');
    expect(formatAreaSize(42_000, 'imperial')).toBe('10.4 ac');
    expect(formatAreaSize(4046.8564224 * 2.5, 'imperial')).toBe('2.5 ac');
    expect(formatAreaSize(5_179_976, 'imperial')).toBe('2 mi²');
  });
});

describe('areaSummaryLine', () => {
  it('reads like the card subtitle', () => {
    expect(areaSummaryLine(RING, 'metric')).toBe('Area · 0.42 km² · perimeter 3.2 km');
  });
});

describe('sortAreasNewestFirst / palette', () => {
  it('newest first, without mutating', () => {
    const a = { id: 'a', createdAt: 1 } as Area;
    const b = { id: 'b', createdAt: 3 } as Area;
    const input = [a, b];
    expect(sortAreasNewestFirst(input).map((x) => x.id)).toEqual(['b', 'a']);
    expect(input[0]).toBe(a);
  });

  it('the palette is distinct #RRGGBB colours, default first', () => {
    expect(new Set(AREA_COLORS.map((c) => c.hex)).size).toBe(AREA_COLORS.length);
    for (const c of AREA_COLORS) expect(c.hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(DEFAULT_AREA_COLOR).toBe(AREA_COLORS[0]!.hex);
  });
});

describe('areaAt', () => {
  const square = (id: string, w: number, s: number, size: number): Area => ({
    id,
    name: id,
    ring: [
      [w, s],
      [w + size, s],
      [w + size, s + size],
      [w, s + size],
    ],
    color: DEFAULT_AREA_COLOR,
    createdAt: 0,
  });
  const big = square('big', -71.3, 46.7, 0.2);
  const small = square('small', -71.25, 46.75, 0.02);

  it('picks the smallest area under the tap', () => {
    expect(areaAt([big, small], [-71.24, 46.76])?.id).toBe('small');
    expect(areaAt([small, big], [-71.24, 46.76])?.id).toBe('small');
    expect(areaAt([big, small], [-71.15, 46.8])?.id).toBe('big');
  });

  it('is null outside every area', () => {
    expect(areaAt([big, small], [-70, 46])).toBeNull();
    expect(areaAt([], [-70, 46])).toBeNull();
  });
});
