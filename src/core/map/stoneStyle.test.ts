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
  CONTOUR_LABEL_LAYOUT,
  CONTOUR_MAX_STEEP,
  contourEmphasis,
  contourStroke,
  elevationLabel,
  IMAGERY_CONTOUR_PAINT,
  IMAGERY_ROAD_OPACITY,
  PARK_BAND_WIDTH,
  PARK_PAINT,
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
  parkInk: '#566B34',
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
  parkInk: '#93A25F',
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

  // Owner, 2026-10: three index lines in view, only one height. MapLibre
  // tries one spot per `symbol-spacing` along a line, a line crossing the
  // tile edge first half a spacing in, and drops a spot where the line bends
  // more than `text-max-angle` under it — it never looks for another.
  describe('heights on every index line in view', () => {
    const contourLabel = () => {
      const { labels } = buildStoneLayers(LIGHT, {
        source: SOURCE,
        contours: {
          source: 'contours',
          sourceLayer: 'contours',
          field: 'ele',
          levelField: 'level',
        },
      });
      const l = labels.find((x) => x.id === `${STONE_LAYER_PREFIX}contour-label`);
      return (l as { layout: Record<string, unknown> }).layout;
    };

    it('lays the heights out with the shared spacing, bend and padding', () => {
      expect(contourLabel()).toMatchObject({
        'symbol-spacing': CONTOUR_LABEL_LAYOUT.spacingPx,
        'text-max-angle': CONTOUR_LABEL_LAYOUT.maxAngleDeg,
        'text-padding': CONTOUR_LABEL_LAYOUT.paddingPx,
      });
    });

    it('tries a spot often enough that a line across a phone screen gets one', () => {
      // A tile is shown at up to 2× its scale before the next zoom's tiles
      // take over, so spots on one line land up to 2 × spacing apart on
      // screen; a 400 px wide phone must still see one on a line crossing it
      // (320 px, the 2.1.0 value, left 640 px gaps).
      const PHONE_WIDTH_PX = 400;
      expect(2 * CONTOUR_LABEL_LAYOUT.spacingPx).toBeLessThanOrEqual(1.1 * PHONE_WIDTH_PX);
      // …but not so often that one line is a string of heights.
      expect(CONTOUR_LABEL_LAYOUT.spacingPx).toBeGreaterThanOrEqual(160);
    });

    it('lets a height sit on a wiggly contour and stack with its neighbours', () => {
      // 25° (2.1.0) rejected most spots on a DEM contour's bends.
      expect(CONTOUR_LABEL_LAYOUT.maxAngleDeg).toBeGreaterThanOrEqual(45);
      expect(CONTOUR_LABEL_LAYOUT.maxAngleDeg).toBeLessThanOrEqual(60);
      expect(CONTOUR_LABEL_LAYOUT.paddingPx).toBeLessThanOrEqual(2);
    });

    it('labels every major level and no minor one', () => {
      const { labels } = buildStoneLayers(LIGHT, {
        source: SOURCE,
        contours: {
          source: 'contours',
          sourceLayer: 'contours',
          field: 'ele',
          levelField: 'level',
        },
      });
      const l = labels.find((x) => x.id === `${STONE_LAYER_PREFIX}contour-label`) as {
        filter: FilterSpecification;
      };
      const f = featureFilter(l.filter, 'filter');
      const at = (ele: number, level: number, extra: Record<string, unknown> = {}) =>
        f.filter({ zoom: 13 }, {
          type: 2,
          properties: { ele, level, ...extra },
        } as never);
      // The owner's three: 50, 100 and 150 m, all index lines at z13.
      for (const ele of [50, 100, 150, 1250]) expect(at(ele, 1)).toBe(true);
      // A coarsened steep tile's lines (k > 1) keep their heights too.
      expect(at(250, 1, { k: 5, s: 3 })).toBe(true);
      for (const ele of [10, 60, 140]) expect(at(ele, 0)).toBe(false);
      expect(at(0, 1)).toBe(false);
    });

    it('passes the style-spec validator, zoom only at the top of each curve', () => {
      const { base, labels } = buildStoneLayers(LIGHT, {
        source: SOURCE,
        contours: {
          source: 'contours',
          sourceLayer: 'contours',
          field: 'ele',
          levelField: 'level',
          coarseField: 'k',
          steepField: 's',
        },
      });
      const errors = validateStyleMin({
        version: 8,
        glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
        sources: {
          [SOURCE]: { type: 'vector', tiles: ['https://t.example/{z}/{x}/{y}.pbf'] },
          contours: { type: 'vector', tiles: ['https://c.example/{z}/{x}/{y}.mvt'] },
        },
        layers: [...base, ...labels],
      } as Parameters<typeof validateStyleMin>[0]);
      expect(errors).toEqual([]);
      // MapLibre iOS crashes on a ['zoom'] that isn't the input of the
      // top-level interpolate/step.
      const label = contourLabel();
      const nestedZoom = (v: unknown, top: boolean): boolean => {
        if (!Array.isArray(v)) return false;
        if (v.length === 1 && v[0] === 'zoom') return !top;
        const isCurve = v[0] === 'interpolate' || v[0] === 'step';
        return v.some((x, i) => {
          const zoomInput = isCurve && top && i === (v[0] === 'interpolate' ? 2 : 1);
          return nestedZoom(x, zoomInput);
        });
      };
      for (const value of Object.values(label)) expect(nestedZoom(value, true)).toBe(false);
    });
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
    // (What still reads `pois`: the trail POIs and, without parks tiles, the park names.)
    expect(
      labels
        .filter((l) => (l as { 'source-layer'?: string })['source-layer'] === 'pois')
        .map((l) => l.id),
    ).toEqual([`${STONE_LAYER_PREFIX}poi`, `${STONE_LAYER_PREFIX}park-label`]);
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

describe('contour steepness emphasis (#509)', () => {
  const TAGGED = {
    source: 'contours',
    sourceLayer: 'contours',
    field: 'ele',
    levelField: 'level',
    coarseField: 'k',
    steepField: 's',
  };
  const UNTAGGED = {
    source: 'contours',
    sourceLayer: 'contours',
    field: 'ele',
    levelField: 'level',
  };
  const layersOf = (scheme: StoneBasemapScheme, contours: typeof UNTAGGED) =>
    buildStoneLayers(scheme, { source: SOURCE, contours }).base;
  const paintOf = (layers: LayerSpecification[], which: 'minor' | 'major') =>
    (layers.find((l) => l.id === `${STONE_LAYER_PREFIX}contour-${which}`)?.paint ?? {}) as Record<
      string,
      unknown
    >;

  const SPEC = {
    'line-color': { type: 'color' },
    'line-opacity': { type: 'number' },
    'line-width': { type: 'number' },
  } as const;
  /** Evaluate a (possibly data-driven) line paint value for one feature. */
  function evaluate(
    prop: keyof typeof SPEC,
    value: unknown,
    properties: Record<string, unknown>,
  ): unknown {
    // A constant colour is a string, which the parser reads as a string literal.
    const expr = typeof value === 'string' ? ['to-color', value] : value;
    const parsed = createExpression(expr, {
      ...SPEC[prop],
      'property-type': 'data-driven',
      expression: { interpolated: true, parameters: ['zoom', 'feature'] },
    } as never);
    if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
    const out: unknown = parsed.value.evaluate({ zoom: 12 }, {
      type: 'LineString',
      properties,
    } as unknown as Parameters<typeof parsed.value.evaluate>[1]);
    return typeof out === 'object' && out !== null ? String(out) : out;
  }

  it('keeps the pre-#509 stroke at emphasis 0', () => {
    expect(contourStroke(0, false, false)).toEqual({ opacity: 0.55, width: 0.7, inkMix: 0 });
    expect(contourStroke(0, false, true)).toEqual({ opacity: 0.5, width: 0.7, inkMix: 0 });
    expect(contourStroke(0, true, false)).toEqual({ opacity: 0.75, width: 1.25, inkMix: 0 });
    expect(contourStroke(0, true, true)).toEqual({ opacity: 0.7, width: 1.25, inkMix: 0 });
  });

  it('grows heavier with steepness, capped at the top class', () => {
    for (const major of [false, true]) {
      for (const dark of [false, true]) {
        const strokes = [0, 1, 2, 3].map((e) => contourStroke(e, major, dark));
        for (let i = 1; i < strokes.length; i++) {
          expect(strokes[i]!.opacity).toBeGreaterThan(strokes[i - 1]!.opacity);
          expect(strokes[i]!.width).toBeGreaterThan(strokes[i - 1]!.width);
          expect(strokes[i]!.inkMix).toBeGreaterThan(strokes[i - 1]!.inkMix);
        }
        expect(contourStroke(9, major, dark)).toEqual(strokes[3]);
        expect(strokes[3]!.opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('only emphasises tiles the Worker coarsened', () => {
    expect(contourEmphasis(UNTAGGED)).toBeNull();
    const e = contourEmphasis(TAGGED);
    const at = (properties: Record<string, unknown>) => evaluate('line-width', e, properties);
    expect(at({ k: 1, s: 3 })).toBe(0);
    expect(at({ s: 3 })).toBe(0);
    expect(at({ k: 3, s: 2 })).toBe(2);
    expect(at({ k: 4, s: 7 })).toBe(CONTOUR_MAX_STEEP);
    expect(at({ k: 4 })).toBe(0);
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])(
    'draws k = 1 tiles (Québec) exactly as before, steep coarsened walls heavier (%s)',
    (_, scheme) => {
      const plain = layersOf(scheme, UNTAGGED);
      const tagged = layersOf(scheme, TAGGED);
      for (const which of ['minor', 'major'] as const) {
        const before = paintOf(plain, which);
        const after = paintOf(tagged, which);
        // Untagged sources keep constant paint.
        expect(before['line-color']).toBe(scheme.contour);
        for (const prop of ['line-color', 'line-opacity', 'line-width'] as const) {
          const asBefore = evaluate(prop, before[prop], {});
          // k = 1 (interval kept), whatever the class — and flat stretches: identical.
          expect(evaluate(prop, after[prop], { k: 1, s: 0 })).toEqual(asBefore);
          expect(evaluate(prop, after[prop], { k: 1, s: 3 })).toEqual(asBefore);
          expect(evaluate(prop, after[prop], { k: 3, s: 0 })).toEqual(asBefore);
        }
        const steep = { k: 3, s: 3 };
        const want = contourStroke(3, which === 'major', scheme.dark);
        expect(evaluate('line-opacity', after['line-opacity'], steep)).toBeCloseTo(want.opacity);
        expect(evaluate('line-width', after['line-width'], steep)).toBeCloseTo(want.width);
        expect(evaluate('line-color', after['line-color'], steep)).not.toEqual(
          evaluate('line-color', before['line-color'], {}),
        );
        // Toward the scheme's ink: only the contour and ink colours appear.
        expect(JSON.stringify(after['line-color'])).toContain(scheme.contour);
        expect(JSON.stringify(after['line-color'])).toContain(scheme.ink);
      }
    },
  );

  it('validates against the MapLibre style spec with the steepness tags', () => {
    const errors = validateStyleMin({
      version: 8,
      sources: {
        [SOURCE]: { type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
        contours: { type: 'vector', tiles: ['https://contours.example/{z}/{x}/{y}.pbf'] },
      },
      glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
      layers: layersOf(DARK, TAGGED),
    });
    expect(errors.map((e) => e.message)).toEqual([]);
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

describe('parks and protected areas', () => {
  const PARKS = { source: 'parks', areaLayer: 'parks', labelLayer: 'park_labels' };
  const strip = (l: LayerSpecification) => l.id.slice(STONE_LAYER_PREFIX.length);
  const PARK_IDS = ['park-band', 'park-outline', 'park-line', 'park-label'];
  type Loose = {
    id: string;
    type: string;
    source?: string;
    'source-layer'?: string;
    minzoom?: number;
    filter?: unknown;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
  };
  const parkLayers = (scheme: StoneBasemapScheme, ours: boolean): Record<string, Loose> => {
    const { base, labels } = buildStoneLayers(scheme, {
      source: SOURCE,
      ...(ours ? { parks: PARKS } : {}),
    });
    return Object.fromEntries(
      [...base, ...labels].filter((l) => PARK_IDS.includes(strip(l))).map((l) => [strip(l), l]),
    ) as Record<string, Loose>;
  };
  /** A layer's filter as a predicate over (tile zoom, feature properties, geometry type). */
  const passes = (layer: Loose) => {
    const f = featureFilter(layer.filter as FilterSpecification, 'filter');
    return (zoom: number, properties: Record<string, unknown>, type: 1 | 2 | 3 = 1) =>
      f.filter({ zoom }, { type, properties, geometry: [] } as unknown as Parameters<
        typeof f.filter
      >[1]);
  };
  const validate = (layers: LayerSpecification[]) =>
    validateStyleMin({
      version: 8,
      glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
      sources: {
        [SOURCE]: { type: 'vector', tiles: ['https://t.example/{z}/{x}/{y}.mvt'] },
        parks: { type: 'vector', tiles: ['https://parks.example/{z}/{x}/{y}.mvt'] },
        peaks: { type: 'vector', tiles: ['https://peaks.example/{z}/{x}/{y}.mvt'] },
      },
      layers,
    } as Parameters<typeof validateStyleMin>[0]).map((e) => e.message);

  it('is on by default: band, quiet dashes and edge in the body, the name among the labels', () => {
    const { base, labels } = buildStoneLayers(LIGHT, { source: SOURCE });
    const ids = base.map(strip);
    // Over the land-use wash, under the water (a lake covers the line crossing it).
    expect(ids.slice(ids.indexOf('park') + 1, ids.indexOf('water'))).toEqual([
      'park-band',
      'park-outline',
      'park-line',
    ]);
    expect(labels.map(strip)).toContain('park-label');
  });

  it('switches off as one: no boundary, no name — the land-use wash stays', () => {
    const { base, labels } = buildStoneLayers(LIGHT, {
      source: SOURCE,
      parks: PARKS,
      protectedAreas: false,
    });
    const ids = [...base, ...labels].map(strip);
    for (const k of PARK_IDS) expect(ids).not.toContain(k);
    expect(ids).toContain('park');
    expect([...base, ...labels].some((l) => (l as Loose).source === PARKS.source)).toBe(false);
  });

  describe("without our tiles (Protomaps' parks)", () => {
    const l = parkLayers(LIGHT, false);

    it('draws national parks, reserves and protected areas strong from z5', () => {
      for (const k of ['park-band', 'park-line']) {
        expect(l[k]).toMatchObject({ source: SOURCE, 'source-layer': 'landuse', minzoom: 5 });
        const due = passes(l[k]!);
        for (const kind of ['national_park', 'nature_reserve', 'protected_area']) {
          expect([kind, due(5, { kind }, 3)]).toEqual([kind, true]);
        }
        // The city park, the wood and the farm get no band.
        for (const kind of ['park', 'forest', 'wood', 'farmland']) {
          expect([kind, due(12, { kind }, 3)]).toEqual([kind, false]);
        }
      }
    });

    it('dashes the `park` polygons quietly, stepping back as the streets arrive', () => {
      const quiet = l['park-outline']!;
      expect(quiet).toMatchObject({ source: SOURCE, 'source-layer': 'landuse', minzoom: 6 });
      expect(passes(quiet)(8, { kind: 'park' }, 3)).toBe(true);
      expect(passes(quiet)(8, { kind: 'national_park' }, 3)).toBe(false);
      expect(quiet.paint?.['line-dasharray']).toEqual([3, 2]);
      expect(quiet.paint?.['line-opacity']).toEqual([
        'interpolate',
        ['linear'],
        ['zoom'],
        12,
        PARK_PAINT.quiet,
        14,
        0.3,
      ]);
    });

    it('names a park from the zoom before its min_zoom (the first tile that carries it)', () => {
      const label = l['park-label']!;
      expect(label).toMatchObject({ source: SOURCE, 'source-layer': 'pois', minzoom: 5 });
      const due = passes(label);
      // As measured on the served tiles (2026-10).
      const banff = { kind: 'national_park', name: 'Banff National Park', min_zoom: 6 };
      const yellowstone = {
        kind: 'nature_reserve',
        name: 'Yellowstone National Park',
        min_zoom: 8,
      };
      const jacques = { kind: 'park', name: 'Parc national de la Jacques-Cartier', min_zoom: 13 };
      expect(due(5, banff)).toBe(true);
      expect(due(6, yellowstone)).toBe(false);
      expect(due(7, yellowstone)).toBe(true);
      expect(due(11, jacques)).toBe(false);
      expect(due(12, jacques)).toBe(true);
      // Not a park, or no name: never.
      expect(due(15, { kind: 'peak', name: 'Mont Sainte-Anne', min_zoom: 13 })).toBe(false);
      expect(due(15, { kind: 'national_park', min_zoom: 6 })).toBe(false);
      expect(label.layout?.['symbol-sort-key']).toEqual([
        'to-number',
        ['coalesce', ['get', 'min_zoom'], 99],
        99,
      ]);
    });
  });

  describe('with our parks tiles', () => {
    const l = parkLayers(LIGHT, true);

    it('draws the national parks strong from their own polygons, as early as z4', () => {
      for (const k of ['park-band', 'park-line']) {
        expect(l[k]).toMatchObject({ source: 'parks', 'source-layer': 'parks', minzoom: 4 });
        expect(passes(l[k]!)(4, { class: 'national', rank: 5 }, 3)).toBe(true);
      }
    });

    it("keeps Protomaps' reserves as quiet dashes from z8, and drops its city parks", () => {
      const quiet = l['park-outline']!;
      expect(quiet).toMatchObject({ source: SOURCE, 'source-layer': 'landuse', minzoom: 8 });
      expect(passes(quiet)(8, { kind: 'nature_reserve' }, 3)).toBe(true);
      expect(passes(quiet)(14, { kind: 'park' }, 3)).toBe(false);
      expect(quiet.paint?.['line-opacity']).toBe(PARK_PAINT.quiet);
    });

    it('takes every name from our label points, the larger area winning', () => {
      const label = l['park-label']!;
      expect(label).toMatchObject({ source: 'parks', 'source-layer': 'park_labels', minzoom: 4 });
      expect(passes(label)(7, { name: 'Parc national de la Jacques-Cartier', rank: 7 })).toBe(true);
      expect(passes(label)(7, { rank: 7 })).toBe(false);
      expect(label.layout?.['symbol-sort-key']).toEqual([
        'to-number',
        ['coalesce', ['get', 'rank'], 99],
        99,
      ]);
      // Protomaps' park names would double ours.
      const { labels } = buildStoneLayers(LIGHT, { source: SOURCE, parks: PARKS, peaks: PEAKS });
      expect(labels.filter((x) => (x as Loose)['source-layer'] === 'pois').map(strip)).toEqual([
        'poi',
      ]);
    });
  });

  it.each([
    ['light', false, LIGHT],
    ['light', true, LIGHT],
    ['dark', false, DARK],
    ['dark', true, DARK],
  ] as const)(
    'inks every park layer in the park green only (%s, our tiles: %s)',
    (_, ours, scheme) => {
      const l = parkLayers(scheme, ours);
      expect(Object.keys(l).sort()).toEqual([...PARK_IDS].sort());
      for (const k of ['park-band', 'park-outline', 'park-line']) {
        expect(l[k]?.type).toBe('line');
        expect(l[k]?.paint?.['line-color']).toBe(scheme.parkInk);
      }
      expect(l['park-label']?.paint).toMatchObject({
        'text-color': scheme.parkInk,
        'text-halo-color': scheme.halo,
      });
      expect(l['park-label']?.layout?.['text-font']).toEqual(STONE_FONTS_ATKINSON.italic);
      // The band is a wash, the edge is ink.
      const band = l['park-band']?.paint?.['line-opacity'] as number;
      expect(band).toBe(scheme.dark ? PARK_PAINT.band.dark : PARK_PAINT.band.light);
      expect(band).toBeLessThan(0.3);
      expect(l['park-line']?.paint?.['line-opacity']).toBe(PARK_PAINT.edge);
    },
  );

  it('insets the band by half its width, and keeps it inside the tile buffer', () => {
    const band = parkLayers(LIGHT, false)['park-band']!;
    const width = band.paint?.['line-width'] as unknown[];
    const offset = band.paint?.['line-offset'] as unknown[];
    expect(width.slice(0, 3)).toEqual(['interpolate', ['exponential', 1.4], ['zoom']]);
    expect(offset.slice(0, 3)).toEqual(['interpolate', ['exponential', 1.4], ['zoom']]);
    expect(width.slice(3)).toEqual(PARK_BAND_WIDTH.flat());
    expect(offset.slice(3)).toEqual(PARK_BAND_WIDTH.flatMap(([z, w]) => [z, w / 2]));
    // Polygons are clipped 8 px past the tile edge; the band reaches `width` px in.
    for (const [, w] of PARK_BAND_WIDTH) expect(w).toBeLessThan(8);
  });

  it('reads the zoom only as the input of a top-level curve (MapLibre iOS crashes otherwise)', () => {
    /** Every path at which `["zoom"]` occurs in an expression. */
    const zoomPaths = (value: unknown, path: number[] = []): number[][] =>
      !Array.isArray(value)
        ? []
        : value.length === 1 && value[0] === 'zoom'
          ? [path]
          : value.flatMap((v, i) => zoomPaths(v, [...path, i]));
    let curves = 0;
    for (const ours of [false, true]) {
      for (const layer of Object.values(parkLayers(DARK, ours))) {
        for (const props of [layer.paint ?? {}, layer.layout ?? {}]) {
          for (const [key, value] of Object.entries(props)) {
            for (const path of zoomPaths(value)) {
              const head = (value as unknown[])[0];
              expect(['interpolate', 'step']).toContain(head);
              // interpolate: [op, interpolation, input, …]; step: [op, input, …].
              expect([layer.id, key, path]).toEqual([layer.id, key, [head === 'step' ? 1 : 2]]);
              curves++;
            }
          }
        }
      }
    }
    expect(curves).toBeGreaterThan(8);
  });

  it('keeps peaks and places legible: the park name is placed after them', () => {
    for (const ours of [false, true]) {
      const { labels } = buildStoneLayers(LIGHT, {
        source: SOURCE,
        peaks: PEAKS,
        ...(ours ? { parks: PARKS } : {}),
      });
      const ids = labels.map(strip);
      // MapLibre places the LAST symbol layer first, so later layers win collisions.
      const park = ids.indexOf('park-label');
      expect(park).toBeGreaterThan(-1);
      for (const k of ['peak', 'place-village', 'place-town', 'place-city']) {
        expect([k, ids.indexOf(k) > park]).toEqual([k, true]);
      }
    }
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])('passes the style-spec validator (%s), with and without our tiles', (_, scheme) => {
    for (const ours of [false, true]) {
      const { base, labels } = buildStoneLayers(scheme, {
        source: SOURCE,
        language: 'fr',
        peaks: PEAKS,
        ...(ours ? { parks: PARKS } : {}),
      });
      expect(validate([...base, ...labels])).toEqual([]);
    }
  });

  describe('over satellite imagery', () => {
    it.each([false, true])(
      'draws the boundary and the name, never a fill (our tiles: %s)',
      (ours) => {
        const layers = buildStoneImageryLayers(DARK, {
          source: SOURCE,
          peaks: PEAKS,
          ...(ours ? { parks: PARKS } : {}),
        });
        const ids = layers.map(strip);
        for (const k of PARK_IDS) expect(ids).toContain(k);
        expect(layers.some((x) => x.type === 'fill')).toBe(false);
        expect(ids).not.toContain('park');
        // Boundaries under the roads and trails; the name under the summits.
        expect(ids.indexOf('park-line')).toBeLessThan(ids.indexOf('road-minor'));
        expect(ids.indexOf('park-label')).toBeLessThan(ids.indexOf('peak'));
        expect(validate(layers)).toEqual([]);
      },
    );

    it('follows the toggle', () => {
      const ids = buildStoneImageryLayers(DARK, { source: SOURCE, protectedAreas: false }).map(
        strip,
      );
      for (const k of PARK_IDS) expect(ids).not.toContain(k);
      expect(ids).toContain('place-town');
    });
  });
});
