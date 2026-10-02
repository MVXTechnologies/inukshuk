import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import {
  CONTOUR_LAYERS,
  FOCUSED_TRAIL_LAYERS,
  HEAT_LAYERS,
  INSPECT_MARKER_LAYER,
  LINE_OUTLINE,
  LIVE_TRAIL_LAYERS,
  lineOutlineFor,
  SLOPE_LAYER,
  TRACKS_LINES_LAYERS,
  pdfDetailLayer,
  pdfOverviewLayer,
  tiltReliefLayer,
} from './mapLayers';
import { HILLSHADE_2D_MIN_ZOOM, HILLSHADE_DEM_SOURCE_ID, TILT_RELIEF_LAYER_ID } from './mapStyle';
import {
  CONTOURS_ANCHOR,
  PDF_MAPS_ANCHOR,
  TERRAIN_OVERLAY_ANCHOR,
  TRAILS_ANCHOR,
} from '@core/geo/mapLayerStack';
import {
  HEAT_GROUND_DARK,
  HEAT_GROUND_LIGHT,
  HEAT_PASS_STRENGTH,
  HEAT_RAMP_LIGHT,
  heatGlowColorStops,
  heatPassStrength,
  rgba,
} from '@core/heat/heatStyle';
import { expression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { stoneScheme } from './stoneScheme';

// Hoisted above the imports by babel-plugin-jest-hoist. The MapLibre native
// modules are looked up with TurboModuleRegistry.getEnforcing at import time,
// which throws under Jest. Stub only the MLRN* ones — a blanket stub breaks
// React Native's own Platform/Animated bootstrap.
jest.mock('react-native/Libraries/TurboModule/TurboModuleRegistry', () => {
  const actual = jest.requireActual('react-native/Libraries/TurboModule/TurboModuleRegistry');
  const isMapLibre = (name: string) => name.startsWith('MLRN');
  return {
    ...actual,
    get: (name: string) => (isMapLibre(name) ? {} : actual.get(name)),
    getEnforcing: (name: string) => (isMapLibre(name) ? {} : actual.getEnforcing(name)),
  };
});

const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * Renders `children` inside a real <GeoJSONSource> and returns, per rendered
 * layer, the `source` prop it actually received — i.e. what MapLibre's own
 * `cloneReactChildrenWithProps` injected, not what we think it injected.
 */
async function injectedSources(children: ReactNode): Promise<[string, unknown][]> {
  const view = await render(
    <GeoJSONSource id="test-source" data={EMPTY as never}>
      {children}
    </GeoJSONSource>,
  );
  // <Layer> tags its rendered native component `mlrn-<type>-layer`.
  return view
    .getAllByTestId(/^mlrn-.+-layer$/)
    .map((node) => [String(node.props.id), node.props.source] as [string, unknown]);
}

describe('hoisted map layers', () => {
  // Regression guard for the Fragment trap: <GeoJSONSource> injects its id with
  // `React.Children.map` + `cloneElement`, and Children.map does NOT descend
  // into a Fragment — a Fragment-wrapped pair silently leaves both layers
  // without a source. Both native sides currently backfill the id, so the bug
  // is invisible on device; this test is the only thing that would catch a
  // regression before a MapLibre bump stops backfilling.
  it.each<[string, unknown, string[]]>([
    ['HEAT_LAYERS.paper.glow', HEAT_LAYERS.paper.glow, ['tracks-heat-glow']],
    ...(['paper', 'night', 'imagery'] as const).flatMap((tone): [string, unknown, string[]][] => [
      [
        `HEAT_LAYERS.${tone}.lines`,
        HEAT_LAYERS[tone].lines,
        ['tracks-heat-lines-casing', 'tracks-heat-lines'],
      ],
      [
        `TRACKS_LINES_LAYERS.${tone}.shown`,
        TRACKS_LINES_LAYERS[tone].shown,
        ['tracks-lines-layer-casing', 'tracks-lines-layer'],
      ],
      [
        `TRACKS_LINES_LAYERS.${tone}.hidden`,
        TRACKS_LINES_LAYERS[tone].hidden,
        ['tracks-lines-layer-casing', 'tracks-lines-layer'],
      ],
      [
        `FOCUSED_TRAIL_LAYERS.${tone}`,
        FOCUSED_TRAIL_LAYERS[tone],
        ['focused-trail-line-layer-casing', 'focused-trail-line-layer'],
      ],
    ]),
    ['HEAT_LAYERS.imagery.glow', HEAT_LAYERS.imagery.glow, ['tracks-heat-glow']],
    ['INSPECT_MARKER_LAYER', INSPECT_MARKER_LAYER, ['inspect-marker-dot']],
    ['LIVE_TRAIL_LAYERS', LIVE_TRAIL_LAYERS, ['trail-casing', 'trail-line']],
    [
      'CONTOUR_LAYERS.plain.minor',
      CONTOUR_LAYERS.plain.minor,
      ['contours2d-minor-halo', 'contours2d-minor-line'],
    ],
    [
      'CONTOUR_LAYERS.plain.major',
      CONTOUR_LAYERS.plain.major,
      ['contours2d-major-halo', 'contours2d-major-line'],
    ],
    [
      'CONTOUR_LAYERS.satellite.minor',
      CONTOUR_LAYERS.satellite.minor,
      ['contours2d-minor-halo', 'contours2d-minor-line'],
    ],
    [
      'CONTOUR_LAYERS.satellite.major',
      CONTOUR_LAYERS.satellite.major,
      ['contours2d-major-halo', 'contours2d-major-line'],
    ],
    ['CONTOUR_LAYERS.stoneLight.minor', CONTOUR_LAYERS.stoneLight.minor, ['contours2d-minor-line']],
    ['CONTOUR_LAYERS.stoneLight.major', CONTOUR_LAYERS.stoneLight.major, ['contours2d-major-line']],
    ['CONTOUR_LAYERS.stoneDark.minor', CONTOUR_LAYERS.stoneDark.minor, ['contours2d-minor-line']],
    ['CONTOUR_LAYERS.stoneDark.major', CONTOUR_LAYERS.stoneDark.major, ['contours2d-major-line']],
  ])('%s: every layer receives the source id', async (_name, children, expectedIds) => {
    const injected = await injectedSources(children as ReactNode);
    expect(injected.map(([id]) => id)).toEqual(expectedIds);
    expect(injected).toEqual(expectedIds.map((id) => [id, 'test-source']));
  });

  // The failure mode this guards against, demonstrated: swap any array above
  // for a Fragment and the layers inside it get `source: null`.
  it('a Fragment wrapper would swallow the injected source (why arrays)', async () => {
    const injected = await injectedSources(
      <>
        <Layer id="frag-a" type="line" />
        <Layer id="frag-b" type="line" />
      </>,
    );
    expect(injected).toEqual([
      ['frag-a', undefined],
      ['frag-b', undefined],
    ]);
  });

  it('the hoisted elements are reference-stable (that is the whole point)', () => {
    // Module-scope constants: re-reading them must not allocate. If one of
    // these ever becomes a function call or a fresh literal, <GeoJSONSource>'s
    // memo breaks again and every MapScreen render re-serializes the geometry.
    expect(LIVE_TRAIL_LAYERS).toBe(LIVE_TRAIL_LAYERS);
    expect(CONTOUR_LAYERS.plain.minor).toBe(CONTOUR_LAYERS.plain.minor);
    expect(CONTOUR_LAYERS.satellite.major).toBe(CONTOUR_LAYERS.satellite.major);
  });
});

// #332 — every layer the map adds after first paint must name the anchor it
// sits under; without `beforeId`, MapLibre appends it above the position
// puck. Reads the prop off the rendered native node, i.e. what MapLibre got.
async function injectedBeforeIds(children: ReactNode): Promise<[string, unknown][]> {
  const view = await render(
    <GeoJSONSource id="test-source" data={EMPTY as never}>
      {children}
    </GeoJSONSource>,
  );
  return view
    .getAllByTestId(/^mlrn-.+-layer$/)
    .map((node) => [String(node.props.id), node.props.beforeId] as [string, unknown]);
}

// #492 — the anchors encode the slot table: on-device contours with the
// contours and the slope over the relief, both UNDER the PDF maps (they used
// to sit above them — "the contour lines in satellite mode go over the PDF
// maps"); trails above the PDF maps; everything below the puck (#332).
describe('overlay layers sit below the position puck (#332) in their slots (#492)', () => {
  it.each([
    ['HEAT_LAYERS.paper.glow', HEAT_LAYERS.paper.glow, TRAILS_ANCHOR],
    ['HEAT_LAYERS.imagery.lines', HEAT_LAYERS.imagery.lines, TRAILS_ANCHOR],
    ['TRACKS_LINES_LAYERS.imagery.shown', TRACKS_LINES_LAYERS.imagery.shown, TRAILS_ANCHOR],
    ['TRACKS_LINES_LAYERS.night.hidden', TRACKS_LINES_LAYERS.night.hidden, TRAILS_ANCHOR],
    ['FOCUSED_TRAIL_LAYERS.paper', FOCUSED_TRAIL_LAYERS.paper, TRAILS_ANCHOR],
    ['INSPECT_MARKER_LAYER', INSPECT_MARKER_LAYER, TRAILS_ANCHOR],
    ['LIVE_TRAIL_LAYERS', LIVE_TRAIL_LAYERS, TRAILS_ANCHOR],
    ['CONTOUR_LAYERS.plain.minor', CONTOUR_LAYERS.plain.minor, CONTOURS_ANCHOR],
    ['CONTOUR_LAYERS.satellite.major', CONTOUR_LAYERS.satellite.major, CONTOURS_ANCHOR],
    ['CONTOUR_LAYERS.stoneDark.major', CONTOUR_LAYERS.stoneDark.major, CONTOURS_ANCHOR],
    ['SLOPE_LAYER', SLOPE_LAYER, TERRAIN_OVERLAY_ANCHOR],
    ['pdfOverviewLayer', pdfOverviewLayer('doc:0'), PDF_MAPS_ANCHOR],
    ['pdfDetailLayer', pdfDetailLayer('doc:0-detail-abc'), PDF_MAPS_ANCHOR],
  ])('%s inserts under %s', async (_name, children, anchor) => {
    const injected = await injectedBeforeIds(children as ReactNode);
    expect(injected.length).toBeGreaterThan(0);
    for (const [, beforeId] of injected) expect(beforeId).toBe(anchor);
  });
});

// #480 — the tilted-map relief pass: the style ships it hidden with its
// colours; this same-id component layer adopts it and drives only visibility
// and exaggeration.
describe('tiltReliefLayer (#480)', () => {
  type Styled = Record<string, { styletype: string; stylevalue: unknown }>;
  async function rendered(exaggeration: number) {
    const view = await render(tiltReliefLayer(exaggeration));
    return view.getByTestId('mlrn-hillshade-layer');
  }

  it('names the style layer it adopts, at the top of the relief slot, on the same DEM', async () => {
    const node = await rendered(0.3);
    expect(node.props.id).toBe(TILT_RELIEF_LAYER_ID);
    expect(node.props.source).toBe(HILLSHADE_DEM_SOURCE_ID);
    // Not `afterId` the flat shading: over satellite there is none (#492).
    expect(node.props.afterId).toBeUndefined();
    expect(node.props.beforeId).toBe(TERRAIN_OVERLAY_ANCHOR);
    expect(node.props.minzoom).toBe(HILLSHADE_2D_MIN_ZOOM);
  });

  it('is visible with the exaggeration when tilted, hidden when flat', async () => {
    const tilted = (await rendered(0.45)).props.reactStyle as Styled;
    expect(JSON.stringify(tilted.visibility?.stylevalue)).toContain('"visible"');
    expect(JSON.stringify(tilted.hillshadeExaggeration)).toContain(
      '{"type":"number","value":0.45}',
    );
    const flat = (await rendered(0)).props.reactStyle as Styled;
    expect(JSON.stringify(flat.visibility?.stylevalue)).toContain('"none"');
  });

  // Device-found (#480, Android emulator): the RN wrapper's hillshade setters
  // read shadow/highlight colours as string ARRAYS and the light direction as
  // a float array. A plain colour or a scalar direction threw "cannot be
  // cast" and killed the React instance; expressions were rejected as not
  // `array<color>`. Those stay in the style JSON — never on this component.
  it('sets nothing but visibility and exaggeration', async () => {
    const rs = (await rendered(0.6)).props.reactStyle as Styled;
    expect(Object.keys(rs).sort()).toEqual(['hillshadeExaggeration', 'visibility']);
  });
});

// #492 — heat and trail lines carry an outline ("casing") under them, tuned
// per ground, so their colours never sink into imagery, the night map or
// the paper map's contours.
describe('line outlines (#492)', () => {
  type Painted = { props: { id: string; paint: Record<string, unknown>; filter?: unknown } };
  const layers = (els: unknown) => els as Painted[];

  it('picks the outline from the ground: imagery in both themes, else the theme', () => {
    expect(lineOutlineFor('satellite', false)).toBe('imagery');
    expect(lineOutlineFor('satellite', true)).toBe('imagery');
    expect(lineOutlineFor('map', false)).toBe('paper');
    expect(lineOutlineFor('map', true)).toBe('night');
  });

  it('is a dark halo on imagery and the night map, a light one on paper', () => {
    expect(LINE_OUTLINE.imagery.color).toBe('#14181C');
    expect(LINE_OUTLINE.night.color).toBe('#14181C');
    expect(LINE_OUTLINE.paper.color).toBe('#FBF8F2');
    // Subtle, never a solid band, and strongest where the ground is busiest.
    for (const o of Object.values(LINE_OUTLINE)) {
      expect(o.opacity).toBeGreaterThan(0.4);
      expect(o.opacity).toBeLessThan(1);
    }
    expect(LINE_OUTLINE.imagery.opacity).toBeGreaterThan(LINE_OUTLINE.night.opacity);
    expect(LINE_OUTLINE.imagery.widthAdd).toBeGreaterThanOrEqual(LINE_OUTLINE.paper.widthAdd);
  });

  it.each(['paper', 'night', 'imagery'] as const)(
    '%s: trail lines draw over a wider casing in the outline colour, same filter',
    (tone) => {
      for (const set of [
        TRACKS_LINES_LAYERS[tone].shown,
        TRACKS_LINES_LAYERS[tone].hidden,
        FOCUSED_TRAIL_LAYERS[tone],
      ]) {
        const [casing, line] = layers(set);
        expect(casing?.props.id).toBe(`${line?.props.id}-casing`);
        expect(casing?.props.paint['line-color']).toBe(LINE_OUTLINE[tone].color);
        expect(casing?.props.paint['line-opacity']).toBe(LINE_OUTLINE[tone].opacity);
        expect(casing?.props.paint['line-width']).toBe(
          (line?.props.paint['line-width'] as number) + LINE_OUTLINE[tone].widthAdd,
        );
        expect(line?.props.paint['line-color']).toEqual(['get', 'color']);
        expect(casing?.props.filter).toEqual(line?.props.filter);
      }
    },
  );

  it.each(['paper', 'night', 'imagery'] as const)(
    '%s: heat lines draw over a casing that widens and fades with them',
    (tone) => {
      const [casing, line] = layers(HEAT_LAYERS[tone].lines);
      expect(casing?.props.paint['line-color']).toBe(LINE_OUTLINE[tone].color);
      const width = JSON.stringify(casing?.props.paint['line-width']);
      expect(width).toContain(`${LINE_OUTLINE[tone].widthAdd}]`);
      // The casing crossfades in with the lines, at the outline's opacity
      // times the pass strength (a lone pass doesn't sit in a full halo).
      const op = casing?.props.paint['line-opacity'] as unknown[];
      expect(op[op.length - 1]).toEqual([
        '*',
        LINE_OUTLINE[tone].opacity,
        expect.arrayContaining(['step', ['get', 'count']]),
      ]);
      expect((line?.props.paint['line-opacity'] as unknown[]).slice(-1)).toEqual([1]);
    },
  );

  // Owner, 2026-10: softer heat — evaluate the real paint at a street zoom.
  describe.each(['paper', 'night', 'imagery'] as const)('%s heat paint', (tone) => {
    const paint = (i: 0 | 1, prop: string) =>
      layers(HEAT_LAYERS[tone].lines)[i]?.props.paint[prop] as never;
    const at = (value: never, type: 'number' | 'color', count: number, zoom = 14) => {
      const parsed = expression.createExpression(value, {
        type,
        'property-type': 'data-driven',
        expression: { interpolated: true, parameters: ['zoom', 'feature'] },
      } as never);
      if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
      return parsed.value.evaluate({ zoom }, { type: 2, properties: { count } } as never);
    };

    it('fades the casing with the line: a lone pass gets a fraction of the halo', () => {
      const casing = paint(0, 'line-opacity');
      expect(at(casing, 'number', 1)).toBeCloseTo(LINE_OUTLINE[tone].opacity * heatPassStrength(1));
      expect(at(casing, 'number', 64)).toBeCloseTo(LINE_OUTLINE[tone].opacity);
      expect(at(casing, 'number', 1)).toBeLessThan(at(casing, 'number', 8));
    });

    it('draws a lone pass thin and many passes wider', () => {
      const w = paint(1, 'line-width');
      expect(at(w, 'number', 1)).toBeCloseTo(1.8);
      expect(at(w, 'number', 8)).toBeGreaterThan(at(w, 'number', 1) * 1.5);
    });

    it('validates, with zoom only as the top-level curve input (MapLibre iOS)', () => {
      const style = {
        version: 8,
        sources: { heat: { type: 'geojson', data: EMPTY } },
        layers: [
          ...layers(HEAT_LAYERS[tone].lines).map((l) => ({ ...l.props, source: 'heat' })),
          {
            ...(HEAT_LAYERS[tone].glow as unknown as Painted).props,
            source: 'heat',
          },
        ].map(({ beforeId: _b, ...l }: Record<string, unknown>) => l),
      };
      expect(validateStyleMin(style as never)).toEqual([]);
    });
  });

  it('fades the lines toward the very grounds the map paints', () => {
    expect(HEAT_GROUND_LIGHT).toBe(stoneScheme(false).land);
    expect(HEAT_GROUND_DARK).toBe(stoneScheme(true).land);
    expect(HEAT_PASS_STRENGTH.length).toBeGreaterThan(1);
  });

  it('glows from the full-strength ramp (the glow fades by alpha)', () => {
    const glow = (HEAT_LAYERS.paper.glow as unknown as Painted).props.paint['heatmap-color'];
    const stops = heatGlowColorStops(HEAT_RAMP_LIGHT);
    expect(JSON.stringify(glow)).toContain(rgba(stops[1]![1], stops[1]![2]));
  });

  it('heats the imagery and night grounds with the dark ramp, paper with the light', () => {
    const colour = (tone: 'paper' | 'night' | 'imagery') =>
      JSON.stringify(layers(HEAT_LAYERS[tone].lines)[1]?.props.paint['line-color']);
    expect(colour('imagery')).toBe(colour('night'));
    expect(colour('paper')).not.toBe(colour('night'));
  });
});
