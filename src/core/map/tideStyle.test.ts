// The reference validator ships with maplibre-react-native (its style-spec dependency).
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { buildGeodeticLayers, GEODETIC_SOURCE } from './geodeticStyle';
import {
  buildTideLayers,
  TIDE_LAYER_IDS,
  TIDE_SOURCE,
  TIDE_TAP_LAYERS,
  tideIconNames,
} from './tideStyle';

const FONT = ['Atkinson Hyperlegible Next Regular'];

/** Every `[..., ["zoom"], ...]` inside a match/case expression (iOS crash). */
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

function styleFor(theme: 'light' | 'dark') {
  return {
    version: 8 as const,
    glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
    sources: {
      [TIDE_SOURCE]: {
        type: 'vector' as const,
        tiles: ['https://t.example/tides/{z}/{x}/{y}.mvt'],
      },
      [GEODETIC_SOURCE]: {
        type: 'vector' as const,
        tiles: ['https://t.example/geodetic/{z}/{x}/{y}.mvt'],
      },
    },
    layers: [
      ...buildGeodeticLayers({ theme, font: FONT }),
      ...buildTideLayers({ theme, font: FONT }),
    ],
  };
}

describe('tide-station layers (and the tidal branch of the geodetic ones)', () => {
  it.each(['light', 'dark'] as const)('validate against the MapLibre style spec (%s)', (theme) => {
    expect(validateStyleMin(styleFor(theme)).map((e) => e.message)).toEqual([]);
  });

  it('never put ["zoom"] inside match or case, and never sort symbols', () => {
    const { layers } = styleFor('light');
    expect(zoomInsideMatchOrCase(layers)).toBe(false);
    expect(JSON.stringify(layers)).not.toContain('symbol-sort-key');
  });

  it('draws dots to z8, symbols from z8, names from z10; taps hit dots and symbols', () => {
    const byId = Object.fromEntries(
      buildTideLayers({ theme: 'dark', font: FONT }).map((l) => [l.id, l]),
    );
    expect(byId[TIDE_LAYER_IDS.dots]).toMatchObject({ type: 'circle', maxzoom: 8 });
    expect(byId[TIDE_LAYER_IDS.symbols]).toMatchObject({ type: 'symbol', minzoom: 8 });
    expect(byId[TIDE_LAYER_IDS.labels]).toMatchObject({ minzoom: 10 });
    expect(TIDE_TAP_LAYERS).toEqual([TIDE_LAYER_IDS.dots, TIDE_LAYER_IDS.symbols]);
    expect(JSON.stringify(byId[TIDE_LAYER_IDS.symbols])).toContain('tide-gauge-dark');
    expect(tideIconNames('light')).toEqual(['tide-gauge-light', 'tide-pred-light']);
  });

  it('gives tidal benchmarks their own symbol and z15 "ID · CD" label', () => {
    const geo = JSON.stringify(buildGeodeticLayers({ theme: 'light', font: FONT }));
    expect(geo).toContain('geodetic-tbm-light');
    expect(geo).toContain('geodetic-tidal-labels');
  });
});
