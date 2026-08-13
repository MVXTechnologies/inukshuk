// The MapLibre native modules are looked up with TurboModuleRegistry.getEnforcing
// at import time, which throws under Jest. Stub only the MLRN* ones — a blanket
// stub breaks React Native's own Platform/Animated bootstrap.
jest.mock('react-native/Libraries/TurboModule/TurboModuleRegistry', () => {
  const actual = jest.requireActual('react-native/Libraries/TurboModule/TurboModuleRegistry');
  const isMapLibre = (name: string) => name.startsWith('MLRN');
  return {
    ...actual,
    get: (name: string) => (isMapLibre(name) ? {} : actual.get(name)),
    getEnforcing: (name: string) => (isMapLibre(name) ? {} : actual.getEnforcing(name)),
  };
});

import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import {
  CONTOUR_LAYERS,
  FOCUSED_TRAIL_LAYER,
  HEATMAP_LAYERS,
  INSPECT_MARKER_LAYER,
  LIVE_TRAIL_LAYERS,
  TRACKS_LINES_LAYER,
} from './mapLayers';

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
    ['HEATMAP_LAYERS', HEATMAP_LAYERS, ['tracks-heatmap']],
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
