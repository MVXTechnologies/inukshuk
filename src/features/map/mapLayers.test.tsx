import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import {
  CONTOUR_LAYERS,
  FOCUSED_TRAIL_LAYER,
  HEAT_LAYERS,
  INSPECT_MARKER_LAYER,
  LIVE_TRAIL_LAYERS,
  SLOPE_LAYER,
  TRACKS_LINES_LAYER,
  pdfDetailLayer,
  pdfOverviewLayer,
  tiltReliefLayer,
} from './mapLayers';
import {
  HILLSHADE_2D_LAYER_ID,
  HILLSHADE_2D_MIN_ZOOM,
  HILLSHADE_DEM_SOURCE_ID,
  TILT_RELIEF_LAYER_ID,
} from './mapStyle';
import {
  CONTOURS_ANCHOR,
  PDF_MAPS_ANCHOR,
  TERRAIN_OVERLAY_ANCHOR,
  TRAILS_ANCHOR,
} from '@core/geo/mapLayerStack';

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
  it.each([
    ['HEAT_LAYERS.light.glow', HEAT_LAYERS.light.glow, ['tracks-heat-glow']],
    ['HEAT_LAYERS.light.lines', HEAT_LAYERS.light.lines, ['tracks-heat-lines']],
    ['HEAT_LAYERS.dark.glow', HEAT_LAYERS.dark.glow, ['tracks-heat-glow']],
    ['HEAT_LAYERS.dark.lines', HEAT_LAYERS.dark.lines, ['tracks-heat-lines']],
    ['TRACKS_LINES_LAYER.shown', TRACKS_LINES_LAYER.shown, ['tracks-lines-layer']],
    ['TRACKS_LINES_LAYER.hidden', TRACKS_LINES_LAYER.hidden, ['tracks-lines-layer']],
    ['FOCUSED_TRAIL_LAYER', FOCUSED_TRAIL_LAYER, ['focused-trail-line-layer']],
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
    ['HEAT_LAYERS.light.glow', HEAT_LAYERS.light.glow, TRAILS_ANCHOR],
    ['HEAT_LAYERS.dark.lines', HEAT_LAYERS.dark.lines, TRAILS_ANCHOR],
    ['TRACKS_LINES_LAYER.shown', TRACKS_LINES_LAYER.shown, TRAILS_ANCHOR],
    ['TRACKS_LINES_LAYER.hidden', TRACKS_LINES_LAYER.hidden, TRAILS_ANCHOR],
    ['FOCUSED_TRAIL_LAYER', FOCUSED_TRAIL_LAYER, TRAILS_ANCHOR],
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

  it('names the style layer it adopts, above the base, on the same DEM', async () => {
    const node = await rendered(0.3);
    expect(node.props.id).toBe(TILT_RELIEF_LAYER_ID);
    expect(node.props.source).toBe(HILLSHADE_DEM_SOURCE_ID);
    expect(node.props.afterId).toBe(HILLSHADE_2D_LAYER_ID);
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
