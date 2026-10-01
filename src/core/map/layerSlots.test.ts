import { DRAPE_ANCHORS_BOTTOM_TO_TOP } from '@core/geo/mapLayerStack';
import {
  drawsImageryLabels,
  drawsShadedRelief,
  drawsTiltRelief,
  elementSlot,
  MAP_LAYER_SLOTS,
  mapDrawOrder,
  OVERLAY_SLOT,
  overlayAnchor,
  SLOT_ANCHOR,
  slotRank,
  stackLayers,
  type MapElement,
  type MapLayerSlot,
  type MapOverlay,
  type MapStackInput,
} from './layerSlots';

const TOGGLES = [
  'vector',
  'dark',
  'shadedRelief',
  'tiltRelief',
  'contours',
  'slope',
  'satelliteLabels',
  'pdf',
  'heat',
  'trails',
  'weather',
  'marine',
  'offlineMask',
] as const;

/** Every combination of every toggle, on both base maps: 2 × 2^13 inputs. */
function everyInput(): MapStackInput[] {
  const out: MapStackInput[] = [];
  for (const basemap of ['map', 'satellite'] as const) {
    for (let bits = 0; bits < 1 << TOGGLES.length; bits++) {
      const input = { basemap } as MapStackInput;
      TOGGLES.forEach((t, n) => {
        input[t] = (bits & (1 << n)) !== 0;
      });
      out.push(input);
    }
  }
  return out;
}

const ALL = everyInput();
const above = (order: MapElement[], upper: MapElement, lower: MapElement) =>
  order.indexOf(upper) > order.indexOf(lower);

describe('the slot table', () => {
  it('has each slot once, the PDF maps above every terrain slot', () => {
    expect(new Set(MAP_LAYER_SLOTS).size).toBe(MAP_LAYER_SLOTS.length);
    for (const s of ['base', 'contours', 'linework', 'chart', 'relief', 'terrain'] as const) {
      expect(slotRank('pdf')).toBeGreaterThan(slotRank(s));
    }
    expect(slotRank('trails')).toBeGreaterThan(slotRank('pdf'));
    // Base-map names stay under the PDF maps: a topo sheet carries its own.
    expect(slotRank('labels')).toBeLessThan(slotRank('pdf'));
  });

  it('flattens slots in table order, whatever order they were filled in', () => {
    const filled: Partial<Record<MapLayerSlot, string[]>> = {};
    filled.trails = ['t'];
    filled.pdf = ['p'];
    filled.contours = ['c1', 'c2'];
    filled.base = ['b'];
    filled.relief = ['r'];
    expect(stackLayers(filled)).toEqual(['b', 'c1', 'c2', 'r', 'p', 't']);
    expect(stackLayers({})).toEqual([]);
  });

  it('gives each runtime slot its own anchor, in the same order as the anchors', () => {
    const slots = Object.keys(SLOT_ANCHOR) as (keyof typeof SLOT_ANCHOR)[];
    const anchors = slots.map((s) => SLOT_ANCHOR[s]);
    expect(new Set(anchors).size).toBe(anchors.length);
    const byRank = [...slots].sort((a, b) => slotRank(a) - slotRank(b)).map((s) => SLOT_ANCHOR[s]);
    expect(byRank).toEqual([...DRAPE_ANCHORS_BOTTOM_TO_TOP]);
  });

  it.each(Object.keys(OVERLAY_SLOT) as MapOverlay[])(
    'mounts the %s overlay at its slot anchor',
    (overlay) => {
      expect(overlayAnchor(overlay)).toBe(SLOT_ANCHOR[OVERLAY_SLOT[overlay]]);
    },
  );

  it('mounts PDF maps above every terrain overlay and under every trail (#492)', () => {
    const at = (o: MapOverlay) =>
      (DRAPE_ANCHORS_BOTTOM_TO_TOP as readonly string[]).indexOf(overlayAnchor(o));
    for (const terrain of ['demContours', 'slope', 'marineDrape', 'weatherDrape'] as const) {
      expect(at('pdfMap')).toBeGreaterThan(at(terrain));
    }
    for (const trail of ['heat', 'trailLines', 'longTrail', 'markers'] as const) {
      expect(at(trail)).toBeGreaterThan(at('pdfMap'));
    }
  });
});

describe('gates', () => {
  const base = { weather: false, marine: false };

  it('shades relief on the Map base only, never under weather or the chart', () => {
    expect(drawsShadedRelief({ ...base, basemap: 'map', shadedRelief: true })).toBe(true);
    expect(drawsShadedRelief({ ...base, basemap: 'satellite', shadedRelief: true })).toBe(false);
    expect(drawsShadedRelief({ ...base, basemap: 'map', shadedRelief: false })).toBe(false);
    expect(
      drawsShadedRelief({ basemap: 'map', shadedRelief: true, weather: true, marine: false }),
    ).toBe(false);
    expect(
      drawsShadedRelief({ basemap: 'map', shadedRelief: true, weather: false, marine: true }),
    ).toBe(false);
  });

  it('draws the tilt pass with the map relief, or alone over imagery', () => {
    const t = { ...base, tiltRelief: true };
    expect(drawsTiltRelief({ ...t, basemap: 'map', shadedRelief: true })).toBe(true);
    expect(drawsTiltRelief({ ...t, basemap: 'map', shadedRelief: false })).toBe(false);
    expect(drawsTiltRelief({ ...t, basemap: 'satellite', shadedRelief: false })).toBe(true);
    expect(
      drawsTiltRelief({ ...t, basemap: 'satellite', shadedRelief: false, tiltRelief: false }),
    ).toBe(false);
    expect(drawsTiltRelief({ ...t, basemap: 'satellite', shadedRelief: true, weather: true })).toBe(
      false,
    );
  });

  it('draws imagery labels on satellite only, with the toggle, without a drape', () => {
    const on = { ...base, vector: true, satelliteLabels: true };
    expect(drawsImageryLabels({ ...on, basemap: 'satellite' })).toBe(true);
    expect(drawsImageryLabels({ ...on, basemap: 'map' })).toBe(false);
    expect(drawsImageryLabels({ ...on, basemap: 'satellite', satelliteLabels: false })).toBe(false);
    expect(drawsImageryLabels({ ...on, basemap: 'satellite', vector: false })).toBe(false);
    expect(drawsImageryLabels({ ...on, basemap: 'satellite', weather: true })).toBe(false);
    expect(drawsImageryLabels({ ...on, basemap: 'satellite', marine: true })).toBe(false);
  });

  it('puts the vector map body in the base slot and imagery overlays in their own', () => {
    expect(elementSlot('contours', { basemap: 'map', vector: true })).toBe('base');
    expect(elementSlot('linework', { basemap: 'map', vector: true })).toBe('base');
    expect(elementSlot('contours', { basemap: 'satellite', vector: true })).toBe('contours');
    expect(elementSlot('linework', { basemap: 'satellite', vector: true })).toBe('linework');
    expect(elementSlot('contours', { basemap: 'map', vector: false })).toBe('contours');
  });
});

describe(`mapDrawOrder — every combination (${ALL.length} inputs)`, () => {
  it('starts with the ground and never repeats an element', () => {
    for (const input of ALL) {
      const order = mapDrawOrder(input);
      expect(order[0]).toBe('ground');
      expect(new Set(order).size).toBe(order.length);
    }
  });

  it('draws PDF maps above contours, relief, slope, line work, names and drapes', () => {
    for (const input of ALL) {
      const order = mapDrawOrder(input);
      if (!order.includes('pdf')) continue;
      for (const under of [
        'ground',
        'contours',
        'linework',
        'chart',
        'relief',
        'tiltRelief',
        'slope',
        'labels',
        'weather',
      ] as const) {
        if (order.includes(under))
          expect([input, under, above(order, 'pdf', under)]).toEqual([input, under, true]);
      }
    }
  });

  it('draws heat and trails above the PDF maps', () => {
    for (const input of ALL) {
      const order = mapDrawOrder(input);
      for (const trail of ['heat', 'trails'] as const) {
        if (order.includes(trail) && order.includes('pdf')) {
          expect(above(order, trail, 'pdf')).toBe(true);
        }
      }
    }
  });

  it('masks every base-map element offline, never the PDF maps or your trails (#492)', () => {
    const device: MapElement[] = ['pdf', 'heat', 'trails'];
    for (const input of ALL) {
      if (!input.offlineMask) continue;
      const order = mapDrawOrder(input);
      for (const e of order) {
        if (e === 'mask' || e === 'reference') continue;
        expect([input, e, above(order, e, 'mask')]).toEqual([input, e, device.includes(e)]);
      }
    }
  });

  it('keeps contours under the roads and trails, the relief over them, names above', () => {
    for (const input of ALL) {
      const order = mapDrawOrder(input);
      const pairs: [MapElement, MapElement][] = [
        ['linework', 'contours'],
        ['relief', 'linework'],
        ['tiltRelief', 'relief'],
        ['slope', 'relief'],
        ['slope', 'contours'],
        ['labels', 'slope'],
        ['labels', 'linework'],
      ];
      for (const [upper, lower] of pairs) {
        if (order.includes(upper) && order.includes(lower)) {
          expect(above(order, upper, lower)).toBe(true);
        }
      }
    }
  });

  it('is the SAME order on both base maps — satellite just lacks the flat relief', () => {
    for (const input of ALL) {
      if (input.basemap !== 'map') continue;
      const map = mapDrawOrder(input);
      const sat = mapDrawOrder({ ...input, basemap: 'satellite' });
      const common = (a: MapElement[], b: MapElement[]) => a.filter((e) => b.includes(e));
      expect(common(map, sat)).toEqual(common(sat, map));
      expect(sat).not.toContain('relief');
    }
  });

  it('gives satellite the tilt pass on its own, with the same drape gates as the map', () => {
    for (const input of ALL) {
      if (input.basemap !== 'satellite') continue;
      const order = mapDrawOrder(input);
      const expected = input.tiltRelief && !input.weather && !input.marine;
      expect(order.includes('tiltRelief')).toBe(expected);
    }
  });

  it('never depends on the theme', () => {
    for (const input of ALL) {
      if (input.dark) continue;
      expect(mapDrawOrder({ ...input, dark: true })).toEqual(mapDrawOrder(input));
    }
  });

  it('spells out the two everyday stacks', () => {
    const everyday: MapStackInput = {
      basemap: 'map',
      vector: true,
      dark: false,
      shadedRelief: true,
      tiltRelief: true,
      contours: true,
      slope: true,
      satelliteLabels: true,
      pdf: true,
      heat: true,
      trails: true,
      weather: false,
      marine: false,
      offlineMask: false,
    };
    expect(mapDrawOrder(everyday)).toEqual([
      'ground',
      'contours',
      'linework',
      'relief',
      'tiltRelief',
      'slope',
      'labels',
      'pdf',
      'heat',
      'trails',
    ]);
    expect(mapDrawOrder({ ...everyday, basemap: 'satellite' })).toEqual([
      'ground',
      'contours',
      'linework',
      'tiltRelief',
      'slope',
      'labels',
      'pdf',
      'heat',
      'trails',
    ]);
  });

  it('drops the on-device overlays under the offline-only mask, keeps served contours', () => {
    const raster: MapStackInput = {
      basemap: 'satellite',
      vector: false,
      dark: false,
      shadedRelief: false,
      tiltRelief: false,
      contours: true,
      slope: true,
      satelliteLabels: false,
      pdf: false,
      heat: false,
      trails: false,
      weather: false,
      marine: false,
      offlineMask: true,
    };
    expect(mapDrawOrder(raster)).toEqual(['ground', 'mask']);
    expect(mapDrawOrder({ ...raster, vector: true })).toEqual(['ground', 'contours', 'mask']);
  });
});
