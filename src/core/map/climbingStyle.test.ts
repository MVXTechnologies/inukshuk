// The reference validator ships with maplibre-react-native (its style-spec dependency).
import { validateStyleMin, featureFilter } from '@maplibre/maplibre-gl-style-spec';
import {
  buildCragTileLayers,
  buildSavedCragLayers,
  climbingColors,
  climbingIconNames,
  CRAG_SOURCE,
  CRAG_TAP_LAYERS,
  cragFacetFilter,
  SAVED_CRAG_SOURCE,
} from './climbingStyle';

const FONT = ['Atkinson Hyperlegible Next Regular'];

function style(
  theme: 'light' | 'dark',
  extra: Parameters<typeof buildCragTileLayers>[0] = { theme, font: FONT },
) {
  return {
    version: 8 as const,
    glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
    sources: {
      [CRAG_SOURCE]: {
        type: 'vector' as const,
        tiles: ['https://tiles.example/crags/{z}/{x}/{y}.mvt'],
      },
      [SAVED_CRAG_SOURCE]: {
        type: 'geojson' as const,
        data: { type: 'FeatureCollection' as const, features: [] },
      },
    },
    layers: [...buildCragTileLayers(extra), ...buildSavedCragLayers({ theme, font: FONT })],
  };
}

/** Every `[..., ["zoom"], ...]` path inside a match/case expression (iOS crash). */
function zoomInsideMatchOrCase(node: unknown, inside = false): boolean {
  if (!Array.isArray(node)) {
    if (typeof node === 'object' && node !== null) {
      return Object.values(node).some((v) => zoomInsideMatchOrCase(v, inside));
    }
    return false;
  }
  if (node[0] === 'zoom' && node.length === 1) return inside;
  const now = inside || node[0] === 'match' || node[0] === 'case';
  return node.some((v) => zoomInsideMatchOrCase(v, now));
}

describe('climbing layers', () => {
  it.each(['light', 'dark'] as const)('validate against the MapLibre style spec (%s)', (theme) => {
    expect(validateStyleMin(style(theme)).map((e) => e.message)).toEqual([]);
    const filtered = style(theme, {
      theme,
      font: FONT,
      saved: ['ob-1'],
      savedMode: 'skip',
      filter: cragFacetFilter({ styles: ['sport', 'boulder'], grade: 'mid' }),
      prefix: 'map-crags',
    });
    expect(validateStyleMin(filtered).map((e) => e.message)).toEqual([]);
  });

  it('never put ["zoom"] inside match or case, and band the sort key', () => {
    const layers = [
      ...buildCragTileLayers({ theme: 'light', font: FONT }),
      ...buildSavedCragLayers({ theme: 'light', font: FONT }),
    ];
    expect(zoomInsideMatchOrCase(layers)).toBe(false);
    for (const l of layers) {
      const key = (l.layout as Record<string, unknown> | undefined)?.['symbol-sort-key'];
      if (key !== undefined) expect((key as unknown[])[0]).toBe('step');
    }
  });

  it('lets badges overlap only from z12', () => {
    const [low, high] = buildCragTileLayers({ theme: 'light', font: FONT });
    expect(low).toMatchObject({ maxzoom: 12, layout: { 'icon-allow-overlap': false } });
    expect(high).toMatchObject({ minzoom: 12, layout: { 'icon-allow-overlap': true } });
  });

  it('names one icon per kind and theme, and tap layers that exist', () => {
    expect(climbingIconNames('dark')).toEqual([
      'crag-hollow-dark',
      'crag-saved-dark',
      'crag-closed-dark',
    ]);
    const ids = [
      ...buildCragTileLayers({ theme: 'light', font: FONT, prefix: 'map-crags' }),
      ...buildSavedCragLayers({ theme: 'light', font: FONT }),
    ].map((l) => l.id);
    for (const id of CRAG_TAP_LAYERS) expect(ids).toContain(id);
    expect(climbingColors('light').bands).toHaveLength(4);
  });
});

describe('cragFacetFilter', () => {
  const evaluate = (f: ReturnType<typeof cragFacetFilter>, props: Record<string, unknown>) =>
    featureFilter(f as never, 'layers[0].filter').filter(
      { zoom: 10 } as never,
      { type: 1, properties: props } as never,
    );

  it('is null without facets', () => {
    expect(cragFacetFilter({})).toBeNull();
    expect(cragFacetFilter({ styles: [], grade: null })).toBeNull();
  });

  it('tests style bits', () => {
    const f = cragFacetFilter({ styles: ['trad'] });
    expect(evaluate(f, { st: 3 })).toBe(true); // sport + trad
    expect(evaluate(f, { st: 1 })).toBe(false);
    expect(evaluate(f, {})).toBe(false);
    expect(evaluate(cragFacetFilter({ styles: ['boulder', 'ice'] }), { st: 16 })).toBe(true);
  });

  it('overlaps grade ranges, ropes or boulders', () => {
    const mid = cragFacetFilter({ grade: 'mid' });
    expect(evaluate(mid, { g0: 4, g1: 12 })).toBe(true);
    expect(evaluate(mid, { g0: 4, g1: 9 })).toBe(false);
    expect(evaluate(mid, { v0: 4, v1: 8 })).toBe(true);
    expect(
      evaluate(cragFacetFilter({ grade: 'hard', styles: ['sport'] }), { st: 1, g0: 10, g1: 20 }),
    ).toBe(true);
  });
});
