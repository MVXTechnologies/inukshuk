import { mapColors } from '@ui/theme';
import { Layer } from '@maplibre/maplibre-react-native';

// ---------------------------------------------------------------------------
// Static <Layer> children for the map's GeoJSON sources, hoisted out of the
// render body.
//
// maplibre-react-native's <GeoJSONSource> is React.memo'd, and its render body
// does `JSON.stringify(data)` (see the package's GeoJSONSource.tsx). memo does
// a SHALLOW prop compare and `children` is a prop — so inline JSX children,
// which are a fresh element object on every parent render, defeat the memo and
// re-serialize the whole geometry every time MapScreen renders. With the
// combined trails source that is megabytes of JSON per render, several times a
// second while recording.
//
// Hoisting these element trees to module scope makes `children` reference-
// stable, so each source re-renders (and re-serializes) only when its `data`
// actually changes. They close over nothing, so hoisting is a pure identity
// change.
//
// MULTI-LAYER SETS MUST BE ARRAYS, NEVER FRAGMENTS. <GeoJSONSource> does not
// render its children verbatim: it injects the source id into each one with
// `cloneReactChildrenWithProps`, which is `React.Children.map(...) +
// cloneElement`. `Children.map` does NOT descend into a Fragment — it treats
// the Fragment as the single child — so a Fragment wrapper receives `source`
// itself and the <Layer>s inside it receive nothing. `Array.isArray(children)`
// is the branch that library handles correctly. Today both native sides
// backfill a missing source id (MLRNSource.kt / MLRNSource.m), so a Fragment
// happens to still draw — but that is a native fallback, not the contract.
// mapLayers.test.tsx renders each of these through the real <GeoJSONSource>
// and asserts every layer got its `source`.
// ---------------------------------------------------------------------------

export const HEATMAP_LAYERS = (
  <Layer
    id="tracks-heatmap"
    type="heatmap"
    paint={{
      'heatmap-weight': 1,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 16, 1.0],
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0,
        'rgba(255,140,0,0)',
        0.15,
        'rgba(255,140,0,0)',
        0.4,
        'rgba(255,140,0,0.18)',
        0.7,
        'rgba(255,130,0,0.35)',
        1,
        'rgba(255,120,0,0.55)',
      ],
      'heatmap-radius': [
        'interpolate',
        ['exponential', 1.6],
        ['zoom'],
        6,
        3,
        10,
        8,
        13,
        16,
        16,
        28,
      ],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 15, 0.5, 18, 0.35],
    }}
  />
);

/** Trail-lines layer, one element per `filter` value (see the selection rule). */
export const TRACKS_LINES_LAYER = {
  shown: (
    <Layer
      id="tracks-lines-layer"
      type="line"
      filter={true}
      layout={{ 'line-cap': 'round', 'line-join': 'round' }}
      paint={{ 'line-color': ['get', 'color'], 'line-width': 3 }}
    />
  ),
  hidden: (
    <Layer
      id="tracks-lines-layer"
      type="line"
      filter={false}
      layout={{ 'line-cap': 'round', 'line-join': 'round' }}
      paint={{ 'line-color': ['get', 'color'], 'line-width': 3 }}
    />
  ),
} as const;

export const FOCUSED_TRAIL_LAYER = (
  <Layer
    id="focused-trail-line-layer"
    type="line"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': ['get', 'color'], 'line-width': 4 }}
  />
);

export const INSPECT_MARKER_LAYER = (
  <Layer
    id="inspect-marker-dot"
    type="circle"
    paint={{
      'circle-radius': 7,
      'circle-color': mapColors.userLocation,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    }}
  />
);

/** Array, not a Fragment — see the note above. */
export const LIVE_TRAIL_LAYERS = [
  <Layer
    key="casing"
    id="trail-casing"
    type="line"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': mapColors.trailCasing, 'line-width': 9 }}
  />,
  <Layer
    key="line"
    id="trail-line"
    type="line"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': mapColors.trail, 'line-width': 5 }}
  />,
];

/** Contour layers per basemap — only the two colour schemes exist. */
function contourLayers(satellite: boolean) {
  return {
    minor: [
      <Layer
        key="halo"
        id="contours2d-minor-halo"
        type="line"
        paint={{
          'line-color': satellite ? '#000000' : '#FFFFFF',
          'line-opacity': 0.35,
          'line-width': 2.2,
        }}
      />,
      <Layer
        key="line"
        id="contours2d-minor-line"
        type="line"
        paint={{
          'line-color': satellite ? '#FFFFFF' : '#4a3b2a',
          'line-opacity': satellite ? 0.8 : 0.5,
          'line-width': 1,
        }}
      />,
    ],
    major: [
      <Layer
        key="halo"
        id="contours2d-major-halo"
        type="line"
        paint={{
          'line-color': satellite ? '#000000' : '#FFFFFF',
          'line-opacity': 0.45,
          'line-width': 3.2,
        }}
      />,
      <Layer
        key="line"
        id="contours2d-major-line"
        type="line"
        paint={{
          'line-color': satellite ? '#FFFFFF' : '#4a3b2a',
          'line-opacity': satellite ? 0.95 : 0.75,
          'line-width': 1.8,
        }}
      />,
    ],
  } as const;
}

export const CONTOUR_LAYERS = {
  satellite: contourLayers(true),
  plain: contourLayers(false),
} as const;
