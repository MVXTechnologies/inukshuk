import { isPurple } from '@core/color/hsl';
import type { LayerSpecification } from '@maplibre/maplibre-react-native';
// The reference validator ships with maplibre-react-native (its style-spec
// dependency). It rejects what the TS types can't see, e.g. two zoom curves
// in one expression — which the native renderer drops silently.
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import {
  buildStoneLayers,
  STONE_FONTS_ATKINSON,
  STONE_FONTS_NOTO,
  STONE_LAYER_PREFIX,
  type StoneBasemapScheme,
} from './stoneStyle';

/** Fixture palettes, deliberately NOT the app tokens: the builder must work from any input. */
const LIGHT: StoneBasemapScheme = {
  dark: false,
  land: '#F2ECE0',
  landAlt: '#E3DDD0',
  vegetation: '#93A25E',
  water: '#5C93B7',
  waterLine: '#5C93B8',
  waterInk: '#2F7FC1',
  roadFill: '#FBF8F2',
  roadCasing: '#D5CEBF',
  path: '#5F6B76',
  lineMuted: '#8A8B8C',
  building: '#D5CEBE',
  contour: '#C98A2B',
  ink: '#1E252C',
  inkMuted: '#4A5561',
  halo: '#F2ECE1',
};

const DARK: StoneBasemapScheme = {
  dark: true,
  land: '#1A1F24',
  landAlt: '#242B32',
  vegetation: '#566B33',
  water: '#5C93B7',
  waterLine: '#5C93B8',
  waterInk: '#8CC4F0',
  roadFill: '#3E4852',
  roadCasing: '#13171B',
  path: '#A7B0B8',
  lineMuted: '#77828E',
  building: '#3E4853',
  contour: '#C98A2B',
  ink: '#E9E4D8',
  inkMuted: '#A7B0B9',
  halo: '#1A1F25',
};

const SOURCE = 'protomaps';
const CONTOURS = {
  source: 'contours',
  sourceLayer: 'contour',
  field: 'height',
  intervalM: 10,
  majorEvery: 5,
};

/** The Protomaps basemap v4 vector layers (docs.protomaps.com/basemaps/layers). */
const PROTOMAPS_SOURCE_LAYERS = new Set([
  'boundaries',
  'buildings',
  'earth',
  'landcover',
  'landuse',
  'places',
  'pois',
  'roads',
  'transit',
  'water',
]);

const all = (scheme: StoneBasemapScheme, contours = false): LayerSpecification[] => {
  const { base, labels } = buildStoneLayers(scheme, {
    source: SOURCE,
    ...(contours ? { contours: CONTOURS } : {}),
  });
  return [...base, ...labels];
};

/** Every colour-valued paint property, as the raw value. */
function paintColours(layers: LayerSpecification[]): unknown[] {
  return layers.flatMap((l) =>
    Object.entries((l.paint ?? {}) as Record<string, unknown>)
      .filter(([k]) => k.endsWith('-color'))
      .map(([, v]) => v),
  );
}

describe('buildStoneLayers', () => {
  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])('gives every %s layer a unique, prefixed id', (_, scheme) => {
    const ids = all(scheme, true).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(STONE_LAYER_PREFIX)).toBe(true);
  });

  it('reads only real Protomaps source layers from the given source', () => {
    for (const l of all(LIGHT)) {
      if (l.type === 'background') continue;
      expect(l).toMatchObject({ source: SOURCE });
      expect(
        PROTOMAPS_SOURCE_LAYERS.has((l as { 'source-layer'?: string })['source-layer'] ?? ''),
      ).toBe(true);
    }
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])('validates against the MapLibre style spec (%s, every option on)', (_, scheme) => {
    const { base, labels } = buildStoneLayers(scheme, {
      source: SOURCE,
      language: 'fr',
      contours: CONTOURS,
    });
    const errors = validateStyleMin({
      version: 8,
      glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
      sources: {
        [SOURCE]: { type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
        contours: { type: 'vector', tiles: ['https://contours.example/{z}/{x}/{y}.pbf'] },
      },
      layers: [...base, ...labels],
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  it('opens with the paper background', () => {
    const [first] = buildStoneLayers(LIGHT, { source: SOURCE }).base;
    expect(first).toEqual({
      id: `${STONE_LAYER_PREFIX}background`,
      type: 'background',
      paint: { 'background-color': LIGHT.land },
    });
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])('draws %s colours ONLY from the input scheme, as plain strings', (_, scheme) => {
    const allowed = new Set(Object.values(scheme).filter((v) => typeof v === 'string'));
    const colours = paintColours(all(scheme, true));
    expect(colours.length).toBeGreaterThan(10);
    for (const c of colours) {
      expect(typeof c).toBe('string');
      expect(allowed.has(c as string)).toBe(true);
    }
  });

  it('uses every scheme colour somewhere (no dead palette fields)', () => {
    const used = new Set(paintColours(all(LIGHT, true)));
    for (const [key, value] of Object.entries(LIGHT)) {
      if (key === 'dark') continue;
      expect([key, used.has(value)]).toEqual([key, true]);
    }
  });

  it('never paints purple', () => {
    for (const c of paintColours([...all(LIGHT, true), ...all(DARK, true)])) {
      expect([c, isPurple(c as string)]).toEqual([c, false]);
    }
  });

  it('gives every symbol layer a non-empty text-font stack (Atkinson by default)', () => {
    const symbols = all(LIGHT).filter((l) => l.type === 'symbol');
    expect(symbols.length).toBeGreaterThan(5);
    const atkinson = new Set(
      [STONE_FONTS_ATKINSON.regular, STONE_FONTS_ATKINSON.bold, STONE_FONTS_ATKINSON.italic].map(
        (f) => f.join(','),
      ),
    );
    for (const l of symbols) {
      const font = (l.layout as Record<string, unknown>)['text-font'];
      expect(Array.isArray(font) && font.length > 0).toBe(true);
      expect(atkinson.has((font as string[]).join(','))).toBe(true);
    }
  });

  it('swaps to the glyph fallback fonts as whole stacks', () => {
    const { labels } = buildStoneLayers(LIGHT, { source: SOURCE, fonts: STONE_FONTS_NOTO });
    const fonts = labels.map((l) => (l.layout as Record<string, unknown>)['text-font']);
    for (const f of fonts)
      expect(JSON.stringify(f)).toMatch(/^\["Noto Sans (Regular|Bold|Italic)"]$/);
  });

  it('keeps every layer of the base below every label', () => {
    const { base, labels } = buildStoneLayers(LIGHT, { source: SOURCE });
    expect(base.every((l) => l.type !== 'symbol')).toBe(true);
    expect(labels.every((l) => l.type === 'symbol')).toBe(true);
  });

  it('draws trails: paths and tracks get their own dashed layers in the path colour', () => {
    const layers = all(LIGHT);
    for (const kind of ['path', 'track']) {
      const layer = layers.find((l) => l.id === `${STONE_LAYER_PREFIX}${kind}`);
      expect(layer).toMatchObject({
        type: 'line',
        'source-layer': 'roads',
        minzoom: 11,
        paint: { 'line-color': LIGHT.path },
      });
      expect((layer?.paint as Record<string, unknown>)['line-dasharray']).toBeDefined();
    }
    // Trails draw above the road ribbons they cross.
    const ids = layers.map((l) => l.id);
    expect(ids.indexOf(`${STONE_LAYER_PREFIX}path`)).toBeGreaterThan(
      ids.indexOf(`${STONE_LAYER_PREFIX}road-motorway`),
    );
  });

  it('keeps urban walkways quiet: thin, faded, late, and under the roads', () => {
    const layers = all(LIGHT);
    const ids = layers.map((l) => l.id);
    const footway = layers.find((l) => l.id === `${STONE_LAYER_PREFIX}footway`);
    const trail = layers.find((l) => l.id === `${STONE_LAYER_PREFIX}path`);
    expect(footway?.minzoom).toBe(15);
    expect((footway?.paint as Record<string, unknown>)['line-opacity']).toBeLessThan(0.6);
    expect(ids.indexOf(`${STONE_LAYER_PREFIX}footway`)).toBeLessThan(
      ids.indexOf(`${STONE_LAYER_PREFIX}road-minor-casing`),
    );
    // A sidewalk is never styled as a trail.
    expect(JSON.stringify((trail as { filter?: unknown }).filter)).not.toContain('footway');
    expect(JSON.stringify((footway as { filter?: unknown }).filter)).toContain('footway');
  });

  it('casts every road casing below every road ribbon', () => {
    const ids = all(LIGHT).map((l) => l.id);
    const lastCasing = Math.max(...ids.flatMap((id, i) => (id.endsWith('-casing') ? [i] : [])));
    const firstRibbon = ids.findIndex((id) => /road-[a-z]+$/.test(id));
    expect(lastCasing).toBeLessThan(firstRibbon);
  });

  it('makes the stone-night variant differ from the light one', () => {
    const light = JSON.stringify(all(LIGHT));
    const dark = JSON.stringify(all(DARK));
    expect(dark).not.toEqual(light);
    // Same structure, though: one layer per id in both.
    expect(all(DARK).map((l) => l.id)).toEqual(all(LIGHT).map((l) => l.id));
    // Night washes woods and water differently, not just recoloured.
    const wood = (s: StoneBasemapScheme) =>
      all(s).find((l) => l.id === `${STONE_LAYER_PREFIX}landcover-wood`)?.paint;
    expect(wood(DARK)).not.toEqual({ ...wood(LIGHT), 'fill-color': DARK.vegetation });
  });

  it('adds contour layers only when a contour source is configured', () => {
    const hasContours = (ls: LayerSpecification[]) => ls.some((l) => l.id.includes('contour'));
    expect(hasContours(all(LIGHT))).toBe(false);
    const withContours = all(LIGHT, true).filter((l) => l.id.includes('contour'));
    expect(withContours.map((l) => l.id)).toEqual([
      `${STONE_LAYER_PREFIX}contour-minor`,
      `${STONE_LAYER_PREFIX}contour-major`,
      `${STONE_LAYER_PREFIX}contour-label`,
    ]);
    for (const l of withContours) {
      expect(l).toMatchObject({ source: 'contours', 'source-layer': 'contour' });
    }
  });

  it('reads major lines from a level field when the tiles carry one', () => {
    const { base } = buildStoneLayers(LIGHT, {
      source: SOURCE,
      contours: { source: 'contours', sourceLayer: 'contours', field: 'ele', levelField: 'level' },
    });
    const major = base.find((l) => l.id === `${STONE_LAYER_PREFIX}contour-major`);
    const minor = base.find((l) => l.id === `${STONE_LAYER_PREFIX}contour-minor`);
    expect((major as { filter?: unknown }).filter).toEqual([
      'all',
      ['>', ['to-number', ['get', 'ele'], 0], 0],
      ['==', ['to-number', ['get', 'level'], 0], 1],
    ]);
    expect(major?.minzoom).toBe(8);
    expect(minor?.minzoom).toBe(10);
  });

  it.each([
    ['fr', 'name:fr'],
    ['en', 'name:en'],
  ] as const)('prefers the %s name when asked', (language, key) => {
    const { labels } = buildStoneLayers(LIGHT, { source: SOURCE, language });
    const town = labels.find((l) => l.id === `${STONE_LAYER_PREFIX}place-town`);
    expect((town?.layout as Record<string, unknown>)['text-field']).toEqual(
      expect.arrayContaining(['coalesce', ['get', key]]),
    );
  });

  it('labels the local name by default', () => {
    const { labels } = buildStoneLayers(LIGHT, { source: SOURCE });
    const town = labels.find((l) => l.id === `${STONE_LAYER_PREFIX}place-town`);
    expect((town?.layout as Record<string, unknown>)['text-field']).toEqual([
      'coalesce',
      ['get', 'name'],
      '',
    ]);
  });

  it('writes the height along major contours only, under the other labels', () => {
    const { labels } = buildStoneLayers(LIGHT, {
      source: SOURCE,
      contours: { source: 'contours', sourceLayer: 'contours', field: 'ele', levelField: 'level' },
    });
    const label = labels[0] as {
      id: string;
      minzoom?: number;
      filter?: unknown;
      layout?: Record<string, unknown>;
    };
    expect(label.id).toBe(`${STONE_LAYER_PREFIX}contour-label`);
    expect(label.minzoom).toBe(12);
    expect(label.filter).toEqual([
      'all',
      ['>', ['to-number', ['get', 'ele'], 0], 0],
      ['==', ['to-number', ['get', 'level'], 0], 1],
    ]);
    expect(label.layout?.['symbol-placement']).toBe('line');
    expect(label.layout?.['text-field']).toEqual([
      'to-string',
      ['round', ['to-number', ['get', 'ele'], 0]],
    ]);
  });

  it('adds no contour label without contours', () => {
    const { labels } = buildStoneLayers(LIGHT, { source: SOURCE });
    expect(labels.some((l) => l.id.includes('contour'))).toBe(false);
  });
});
