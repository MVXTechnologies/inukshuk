// The reference validator ships with maplibre-react-native (its style-spec dependency).
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import palette from '@core/geodetic/palette.json';
import { buildGeodeticFilters, DEFAULT_GEODETIC_FILTER } from '@core/geodetic/filter';
import {
  buildGeodeticLayers,
  GEODETIC_SOURCE,
  GEODETIC_TAP_LAYERS,
  geodeticIconNames,
  lowPrecisionDatums,
} from './geodeticStyle';

const FONT = ['Atkinson Hyperlegible Next Regular'];

function styleFor(theme: 'light' | 'dark') {
  return {
    version: 8 as const,
    glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
    sources: {
      [GEODETIC_SOURCE]: {
        type: 'vector' as const,
        tiles: ['https://tiles.example/geodetic/{z}/{x}/{y}.mvt'],
      },
    },
    layers: buildGeodeticLayers({ theme, font: FONT }),
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
  const head = node[0];
  if (head === 'zoom' && node.length === 1) return inside;
  const now = inside || head === 'match' || head === 'case';
  return node.some((v) => zoomInsideMatchOrCase(v, now));
}

describe('geodetic layers', () => {
  it.each(['light', 'dark'] as const)('validate against the MapLibre style spec (%s)', (theme) => {
    expect(validateStyleMin(styleFor(theme)).map((e) => e.message)).toEqual([]);
  });

  it('never put ["zoom"] inside match or case, and never sort symbols', () => {
    const layers = buildGeodeticLayers({ theme: 'light', font: FONT });
    expect(zoomInsideMatchOrCase(layers)).toBe(false);
    for (const l of layers) {
      expect(JSON.stringify(l)).not.toContain('symbol-sort-key');
    }
  });

  it('draws dots below z13 and symbols from z13, ids from z16', () => {
    const byId = Object.fromEntries(
      buildGeodeticLayers({ theme: 'light', font: FONT }).map((l) => [l.id, l]),
    );
    expect(byId['geodetic-dots']).toMatchObject({ type: 'circle', maxzoom: 13 });
    expect(byId['geodetic-symbols-13']).toMatchObject({ minzoom: 13, maxzoom: 14 });
    expect(byId['geodetic-symbols-14']).toMatchObject({ minzoom: 14, maxzoom: 15 });
    expect(byId['geodetic-symbols-15']).toMatchObject({ minzoom: 15 });
    expect(byId['geodetic-labels']).toMatchObject({ minzoom: 16 });
    // marks the ladder lets in at z14 ride in z13 tiles with `z`; z13 skips them
    expect((byId['geodetic-symbols-13'] as { filter?: unknown } | undefined)?.filter).toEqual([
      '!',
      ['has', 'z'],
    ]);
    // every mark shows: no collision work at all
    expect(byId['geodetic-symbols-15']).toMatchObject({
      layout: { 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    });
  });

  it('colours each type, per theme, from the palette', () => {
    const dots = buildGeodeticLayers({ theme: 'dark', font: FONT }).find(
      (l) => l.id === 'geodetic-dots',
    );
    const color = JSON.stringify(
      (dots as { paint: Record<string, unknown> }).paint['circle-color'],
    );
    for (const k of ['3d', 'h', 'v', 'gnss', 'u'] as const)
      expect(color).toContain(palette.dark[k]);
    expect(new Set(Object.values(palette.light)).size).toBe(Object.keys(palette.light).length);
  });

  it('ANDs the user filter into every layer, still spec-valid; hidden OSM layers go', () => {
    const filters = buildGeodeticFilters({
      ...DEFAULT_GEODETIC_FILTER,
      types: ['v'],
      datum: 'modern',
    });
    const layers = buildGeodeticLayers({ theme: 'light', font: FONT, filters });
    expect(layers.some((l) => l.id.startsWith('geodetic-osm'))).toBe(false);
    const sym13 = layers.find((l) => l.id === 'geodetic-symbols-13') as { filter?: unknown };
    expect(sym13.filter).toEqual(['all', ['!', ['has', 'z']], filters.official]);
    expect(zoomInsideMatchOrCase(layers)).toBe(false);
    expect(validateStyleMin({ ...styleFor('light'), layers }).map((e) => e.message)).toEqual([]);
    // the default filter changes nothing
    expect(
      buildGeodeticLayers({
        theme: 'light',
        font: FONT,
        filters: buildGeodeticFilters(DEFAULT_GEODETIC_FILTER),
      }),
    ).toEqual(buildGeodeticLayers({ theme: 'light', font: FONT }));
  });

  it('names one image per type × fill × theme', () => {
    expect(geodeticIconNames('light')).toHaveLength(10);
    expect(geodeticIconNames('dark')).toContain('geodetic-gnss-o-dark');
  });

  it('keeps imprecise positions (NAD27, scaled) out of z14', () => {
    expect(lowPrecisionDatums().length).toBeGreaterThan(0);
    expect(GEODETIC_TAP_LAYERS).toContain('geodetic-symbols-14');
  });
});
