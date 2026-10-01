import { isPurple } from '@core/color/hsl';
import type { LayerSpecification } from '@maplibre/maplibre-react-native';
// The reference validator ships with maplibre-react-native (its style-spec
// dependency). It rejects what the TS types can't see, e.g. two zoom curves
// in one expression — which the native renderer drops silently.
import {
  createExpression,
  featureFilter,
  validateStyleMin,
} from '@maplibre/maplibre-gl-style-spec';
import type { FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { PEAK_DENSITIES, PEAK_LEAD, type PeakDensity } from './terrainOptions';
import {
  buildStoneImageryLayers,
  buildStoneImagerySlots,
  buildStoneLayers,
  elevationLabel,
  IMAGERY_CONTOUR_PAINT,
  IMAGERY_ROAD_OPACITY,
  peakDueFilter,
  STONE_FONTS_ATKINSON,
  STONE_FONTS_NOTO,
  STONE_IMAGERY_LAYER_KEYS,
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
const PEAKS = { source: 'peaks', sourceLayer: 'peaks' };
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
      peaks: PEAKS,
    });
    const errors = validateStyleMin({
      version: 8,
      glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
      sources: {
        [SOURCE]: { type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
        contours: { type: 'vector', tiles: ['https://contours.example/{z}/{x}/{y}.pbf'] },
        peaks: { type: 'vector', tiles: ['https://peaks.example/{z}/{x}/{y}.pbf'] },
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

  const peakOf = (layers: LayerSpecification[]) =>
    layers.find((l) => l.id === `${STONE_LAYER_PREFIX}peak`) as
      (LayerSpecification & { layout: Record<string, unknown>; filter?: unknown }) | undefined;

  it('labels peaks from our summit tiles from z5 when a peaks source is configured', () => {
    const { labels } = buildStoneLayers(LIGHT, { source: SOURCE, peaks: PEAKS });
    const peak = peakOf(labels);
    expect(peak).toMatchObject({ source: 'peaks', 'source-layer': 'peaks', minzoom: 5 });
    // The tiles hold only named summits; the filter picks how early (#461).
    expect(peak?.filter).toEqual(peakDueFilter(PEAK_LEAD.normal));
    // Higher summits win collisions.
    expect(peak?.layout['symbol-sort-key']).toEqual([
      '-',
      0,
      ['to-number', ['coalesce', ['get', 'ele'], 0], 0],
    ]);
    // Exactly one peak layer: Protomaps' own peaks would duplicate ours at z13+.
    expect(
      labels.filter((l) => (l as { 'source-layer'?: string })['source-layer'] === 'pois'),
    ).toHaveLength(1);
    expect(labels.filter((l) => l.id.includes('peak'))).toHaveLength(1);
  });

  it("falls back to Protomaps' peaks (z13+ data) without a peaks source", () => {
    const peak = peakOf(buildStoneLayers(LIGHT, { source: SOURCE }).labels);
    expect(peak).toMatchObject({ source: SOURCE, 'source-layer': 'pois', minzoom: 11 });
    expect(JSON.stringify(peak?.layout['text-field'])).toContain('"elevation"');
  });

  it('draws peaks under the place labels, so towns keep their names', () => {
    const ids = buildStoneLayers(LIGHT, { source: SOURCE, peaks: PEAKS }).labels.map((l) => l.id);
    const peak = ids.indexOf(`${STONE_LAYER_PREFIX}peak`);
    for (const place of ['place-village', 'place-town', 'place-city']) {
      expect(ids.indexOf(`${STONE_LAYER_PREFIX}${place}`)).toBeGreaterThan(peak);
    }
  });

  it('sets the name in bold over the height, in the scheme ink', () => {
    const peak = peakOf(buildStoneLayers(DARK, { source: SOURCE, peaks: PEAKS }).labels);
    const field = peak?.layout['text-field'] as unknown[];
    expect(field[0]).toBe('format');
    expect(field[2]).toEqual({ 'text-font': ['literal', STONE_FONTS_ATKINSON.bold] });
    expect(field[3]).toEqual(['case', ['has', 'ele'], ['concat', '\n', elevationLabel('ele')], '']);
    expect(field[4]).toEqual({ 'font-scale': 0.85 });
    expect((peak?.paint as Record<string, unknown>)['text-color']).toBe(DARK.ink);
  });
});

describe('peak density (#461)', () => {
  const peakFilter = (density?: PeakDensity) => {
    const peak = buildStoneLayers(LIGHT, {
      source: SOURCE,
      peaks: PEAKS,
      ...(density ? { peakDensity: density } : {}),
    }).labels.find((l) => l.id === `${STONE_LAYER_PREFIX}peak`) as { filter?: unknown };
    const f = featureFilter(peak.filter as FilterSpecification, 'filter');
    return (zoom: number, properties: Record<string, unknown>) =>
      f.filter({ zoom }, {
        type: 1,
        properties,
        geometry: [],
      } as unknown as Parameters<typeof f.filter>[1]);
  };

  // Mont Sainte-Anne (808 m): rank z10 on the elevation ladder.
  const msa = { name: 'Mont Sainte-Anne', ele: 808, rank: 10 };

  it.each([
    ['fewer', 10],
    ['normal', 9],
    ['more', 8],
  ] as const)('%s draws a rank-10 summit from z%i', (density, first) => {
    const due = peakFilter(density);
    expect(due(first - 1, msa)).toBe(false);
    expect(due(first, msa)).toBe(true);
    expect(due(first + 3, msa)).toBe(true);
  });

  it('defaults to normal — one zoom earlier than the old ladder', () => {
    const due = peakFilter();
    expect(due(9, msa)).toBe(true);
    expect(due(8, msa)).toBe(false);
  });

  it('draws every summit of pre-#461 tiles (no rank: already tiled from its zoom)', () => {
    for (const d of PEAK_DENSITIES) expect(peakFilter(d)(5, { name: 'Old', ele: 808 })).toBe(true);
  });

  it('orders the densities: more ⊇ normal ⊇ fewer at every zoom', () => {
    for (let rank = 5; rank <= 12; rank++) {
      for (let zoom = 5; zoom <= 14; zoom++) {
        const f = { name: 'X', rank };
        const [fewer, normal, more] = PEAK_DENSITIES.map((d) => peakFilter(d)(zoom, f));
        if (fewer) expect(normal).toBe(true);
        if (normal) expect(more).toBe(true);
      }
    }
  });

  it('keeps collisions sane: higher summits win and labels get extra padding', () => {
    for (const d of PEAK_DENSITIES) {
      const peak = buildStoneLayers(DARK, {
        source: SOURCE,
        peaks: PEAKS,
        peakDensity: d,
      }).labels.find((l) => l.id === `${STONE_LAYER_PREFIX}peak`) as {
        layout: Record<string, unknown>;
      };
      expect(peak.layout['text-padding']).toBe(6);
      expect(peak.layout['symbol-sort-key']).toBeDefined();
    }
  });

  it('passes the style-spec validator for every density', () => {
    for (const d of PEAK_DENSITIES) {
      const { base, labels } = buildStoneLayers(LIGHT, {
        source: SOURCE,
        peaks: PEAKS,
        peakDensity: d,
      });
      const errors = validateStyleMin({
        version: 8,
        glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
        sources: {
          [SOURCE]: { type: 'vector', tiles: ['https://t.example/{z}/{x}/{y}.pbf'] },
          peaks: { type: 'vector', tiles: ['https://peaks.example/{z}/{x}/{y}.pbf'] },
        },
        layers: [...base, ...labels],
      } as Parameters<typeof validateStyleMin>[0]);
      expect(errors).toEqual([]);
    }
  });
});

describe('elevationLabel', () => {
  const evaluate = (properties: Record<string, unknown>): unknown => {
    const parsed = createExpression(elevationLabel('ele'), 'layers[0].layout.text-field');
    if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
    return parsed.value.evaluate({ zoom: 10 }, {
      type: 'Point',
      properties,
    } as unknown as Parameters<typeof parsed.value.evaluate>[1]);
  };

  it.each([
    [808, '808\u00a0m'],
    [4, '4\u00a0m'],
    [1000, '1\u2009000\u00a0m'],
    [1005, '1\u2009005\u00a0m'],
    [1234, '1\u2009234\u00a0m'],
    [1299.6, '1\u2009300\u00a0m'],
    [8849, '8\u2009849\u00a0m'],
    [-12, '-12\u00a0m'],
  ])('%s → %j', (ele, text) => {
    expect(evaluate({ ele })).toBe(text);
  });

  it('is empty without a height', () => {
    expect(evaluate({})).toBe('');
  });

  it('never offers a line break inside the height (#461)', () => {
    // MapLibre wraps point labels at these characters (its `breakable` table).
    const breakable = /[ \n&()+\-/\u00ad\u00b7\u200b\u2010\u2013\u2027]/;
    for (const ele of [4, 808, 1234, 8849]) {
      expect(evaluate({ ele })).not.toMatch(breakable);
    }
  });
});

describe('buildStoneImageryLayers (labels on satellite, #484)', () => {
  const imagery = (scheme: StoneBasemapScheme) =>
    buildStoneImageryLayers(scheme, { source: SOURCE, peaks: PEAKS });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])('keeps only line work and labels — never a ground fill (%s)', (_, scheme) => {
    const layers = imagery(scheme);
    expect(layers.length).toBe(STONE_IMAGERY_LAYER_KEYS.length);
    for (const l of layers) expect(['line', 'symbol']).toContain(l.type);
    const ids = layers.map((l) => l.id);
    expect(ids).not.toContain(`${STONE_LAYER_PREFIX}background`);
    expect(ids).not.toContain(`${STONE_LAYER_PREFIX}water`);
    expect(ids.some((id) => id.includes('contour'))).toBe(false);
  });

  it('carries the trails, the roads and the place and water names', () => {
    const ids = imagery(LIGHT).map((l) => l.id.slice(STONE_LAYER_PREFIX.length));
    for (const k of ['path', 'track', 'road-minor', 'road-motorway', 'place-town']) {
      expect(ids).toContain(k);
    }
    expect(ids).toContain('waterway-label');
    expect(ids).toContain('peak');
  });

  it('drops the road casings and lets the imagery show through the ribbons', () => {
    const layers = imagery(LIGHT);
    expect(layers.some((l) => l.id.endsWith('-casing'))).toBe(false);
    const road = layers.find((l) => l.id === `${STONE_LAYER_PREFIX}road-primary`);
    expect((road?.paint as Record<string, unknown>)['line-opacity']).toBe(IMAGERY_ROAD_OPACITY);
    // Trails keep their own treatment.
    const path = layers.find((l) => l.id === `${STONE_LAYER_PREFIX}path`);
    expect((path?.paint as Record<string, unknown>)['line-opacity']).toBeUndefined();
  });

  it('keeps the map draw order: line work under every label', () => {
    const layers = imagery(LIGHT);
    const lastLine = layers.map((l) => l.type).lastIndexOf('line');
    const firstLabel = layers.findIndex((l) => l.type === 'symbol');
    expect(lastLine).toBeLessThan(firstLabel);
  });

  it('passes the style-spec validator', () => {
    const style = {
      version: 8 as const,
      glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
      sources: {
        [SOURCE]: { type: 'vector' as const, tiles: ['https://t.example/{z}/{x}/{y}.mvt'] },
        peaks: { type: 'vector' as const, tiles: ['https://p.example/{z}/{x}/{y}.mvt'] },
      },
      layers: imagery(DARK),
    };
    expect(validateStyleMin(style as never)).toEqual([]);
  });
});

describe('buildStoneImagerySlots (contours on satellite, #492)', () => {
  const slots = (scheme: StoneBasemapScheme, labels = true) =>
    buildStoneImagerySlots(scheme, {
      source: SOURCE,
      peaks: PEAKS,
      contours: { ...CONTOURS, levelField: 'level' },
      labels,
    });
  const strip = (l: LayerSpecification) => l.id.slice(STONE_LAYER_PREFIX.length);

  it('splits contours, line work and labels into their own slots', () => {
    const { contours, linework, labels } = slots(DARK);
    expect(contours.map(strip)).toEqual([
      'contour-minor-casing',
      'contour-minor',
      'contour-major-casing',
      'contour-major',
    ]);
    for (const l of linework) expect(l.type).toBe('line');
    expect(linework.map(strip)).toContain('path');
    // Heights first among the labels, so names win any collision.
    expect(labels[0] && strip(labels[0])).toBe('contour-label');
    for (const l of labels) expect(l.type).toBe('symbol');
  });

  it('matches the flat list for line work and labels', () => {
    const { linework, labels } = slots(DARK);
    const flat = buildStoneImageryLayers(DARK, { source: SOURCE, peaks: PEAKS });
    expect([...linework, ...labels.filter((l) => !l.id.includes('contour'))]).toEqual(flat);
  });

  it('draws each contour line over a dark casing in the halo colour, majors stronger', () => {
    const { contours } = slots(DARK);
    const paint = (id: string) =>
      contours.find((l) => strip(l) === id)?.paint as Record<string, unknown>;
    for (const kind of ['minor', 'major'] as const) {
      expect(paint(`contour-${kind}`)['line-color']).toBe(DARK.contour);
      expect(paint(`contour-${kind}-casing`)['line-color']).toBe(DARK.halo);
      expect(paint(`contour-${kind}-casing`)['line-width']).toBeGreaterThan(
        paint(`contour-${kind}`)['line-width'] as number,
      );
      expect(paint(`contour-${kind}`)['line-opacity']).toBe(
        IMAGERY_CONTOUR_PAINT[kind].lineOpacity,
      );
    }
    expect(IMAGERY_CONTOUR_PAINT.major.lineOpacity).toBeGreaterThan(
      IMAGERY_CONTOUR_PAINT.minor.lineOpacity,
    );
    // Casings keep the line's source, filter and zoom range.
    const minor = contours.find((l) => strip(l) === 'contour-minor');
    const casing = contours.find((l) => strip(l) === 'contour-minor-casing');
    expect({ ...casing, id: '', paint: {} }).toEqual({ ...minor, id: '', paint: {} });
  });

  it('draws only the contours (and their heights) with labels off', () => {
    const { contours, linework, labels } = slots(DARK, false);
    expect(contours.length).toBe(4);
    expect(linework).toEqual([]);
    expect(labels.map(strip)).toEqual(['contour-label']);
  });

  it('draws no contours without a contour source', () => {
    const { contours, labels } = buildStoneImagerySlots(DARK, { source: SOURCE });
    expect(contours).toEqual([]);
    expect(labels.some((l) => l.id.includes('contour'))).toBe(false);
  });

  it('passes the style-spec validator', () => {
    const { contours, linework, labels } = slots(DARK);
    const style = {
      version: 8 as const,
      glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
      sources: {
        [SOURCE]: { type: 'vector' as const, tiles: ['https://t.example/{z}/{x}/{y}.mvt'] },
        peaks: { type: 'vector' as const, tiles: ['https://p.example/{z}/{x}/{y}.mvt'] },
        contours: { type: 'vector' as const, tiles: ['https://c.example/{z}/{x}/{y}.mvt'] },
      },
      layers: [...contours, ...linework, ...labels],
    };
    expect(validateStyleMin(style as never)).toEqual([]);
  });
});
