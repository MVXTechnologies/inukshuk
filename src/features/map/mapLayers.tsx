import { mapColors } from '@ui/theme';
import { palette } from '@ui/tokens';
import { Layer } from '@maplibre/maplibre-react-native';
import type { ReactElement } from 'react';
import { overlayAnchor } from '@core/map/layerSlots';
import { HILLSHADE_2D_MIN_ZOOM, HILLSHADE_DEM_SOURCE_ID, TILT_RELIEF_LAYER_ID } from './mapStyle';
import {
  HEAT_CROSSFADE,
  HEAT_GLOW_BASE_WEIGHT,
  HEAT_GLOW_INTENSITY,
  HEAT_GLOW_RADIUS_STOPS,
  HEAT_LINE_RAMP_DARK,
  HEAT_LINE_RAMP_LIGHT,
  HEAT_LINE_WIDTH_STOPS,
  HEAT_PASS_STRENGTH,
  HEAT_RAMP_DARK,
  HEAT_RAMP_LIGHT,
  HEAT_WIDTH_MAX_GAIN,
  HEAT_WIDTH_PER_DOUBLING,
  heatGlowColorStops,
  heatGlowOpacity,
  heatLineOpacity,
  rgba,
  type Ramp,
} from '@core/heat/heatStyle';

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
//
// HEIGHT COMES FROM THE SLOT TABLE. Every layer here names its anchor
// through `overlayAnchor` (`@core/map/layerSlots`), the one place the map's
// draw order is defined for both base maps (#492).
// ---------------------------------------------------------------------------

/** Where each runtime overlay mounts (see `@core/map/layerSlots`). */
const HEAT_ANCHOR = overlayAnchor('heat');
const TRAIL_LINES_ANCHOR = overlayAnchor('trailLines');
const MARKERS_ANCHOR = overlayAnchor('markers');
const DEM_CONTOURS_ANCHOR = overlayAnchor('demContours');
const SLOPE_ANCHOR = overlayAnchor('slope');
const PDF_MAP_ANCHOR = overlayAnchor('pdfMap');
/** The relief slot's top: the slope's anchor sits directly above it. */
const RELIEF_TOP_ANCHOR = SLOPE_ANCHOR;

/**
 * The outline ("casing") drawn under the heat lines and trail lines (#492),
 * per ground: a line's own colour cannot win against every ground, so a thin
 * halo of the opposite polarity carries its contrast with it. Over imagery
 * it is a soft shadow — category and heat colours sank into forest and
 * water without one; on the night map the same shadow, lighter; on the
 * paper map a paper halo that lifts the line off contours and roads.
 */
export type LineOutline = 'paper' | 'night' | 'imagery';

export const LINE_OUTLINE: Readonly<
  Record<LineOutline, { color: string; opacity: number; widthAdd: number }>
> = {
  paper: { color: palette.surface, opacity: 0.75, widthAdd: 2 },
  night: { color: palette.shadow, opacity: 0.55, widthAdd: 2 },
  imagery: { color: palette.shadow, opacity: 0.7, widthAdd: 2.5 },
};

/** Which outline the lines get on this ground. */
export function lineOutlineFor(basemap: 'map' | 'satellite', dark: boolean): LineOutline {
  if (basemap === 'satellite') return 'imagery';
  return dark ? 'night' : 'paper';
}

/**
 * The personal heatmap (#466), one set per ground. Street zooms draw the
 * pass-count lines (`useTrackHeat.heatLines`): crisp, 1–7 px, a single pass
 * a faint thin line and only much-run streets hot, over the ground's
 * outline (#492), itself as faint as its line; low zooms draw a soft glow from the coarse grid
 * (`useTrackHeat.heatGlow`). The two crossfade over `HEAT_CROSSFADE`. All
 * numbers live in `@core/heat/heatStyle` (shared with the offline PNG
 * preview).
 *
 * `lines` is an ARRAY, casing first: both name the same anchor, and of two
 * children inserted below one anchor the later one lands on top.
 */
function heatLayers(ramp: Ramp, glowRamp: Ramp, tone: LineOutline) {
  const widthFactor = [
    '+',
    1,
    [
      'min',
      HEAT_WIDTH_MAX_GAIN,
      ['*', HEAT_WIDTH_PER_DOUBLING, ['log2', ['max', 1, ['get', 'count']]]],
    ],
  ];
  // The pass strength (`heatPassStrength`) as a step on the count: scales the
  // casing, so a lone pass doesn't sit in a full-strength halo.
  const [firstStrength, ...moreStrength] = HEAT_PASS_STRENGTH;
  const strength = [
    'step',
    ['get', 'count'],
    firstStrength?.[1] ?? 1,
    ...moreStrength.flatMap(([count, s]) => [count, s]),
  ];
  const outline = LINE_OUTLINE[tone];
  const [first, ...rest] = ramp;
  const lineWidth = (add: number) =>
    [
      'interpolate',
      ['linear'],
      ['zoom'],
      ...HEAT_LINE_WIDTH_STOPS.flatMap(([z, px]) => [z, ['+', ['*', px, widthFactor], add]]),
    ] as never;
  const lineOpacity = (k: number) =>
    [
      'interpolate',
      ['linear'],
      ['zoom'],
      HEAT_CROSSFADE[0],
      heatLineOpacity(HEAT_CROSSFADE[0]) * k,
      HEAT_CROSSFADE[1],
      k,
    ] as never;
  // The casing's: as above, times the pass strength — zoom stays the
  // top-level input (MapLibre iOS crashes on a nested ['zoom']).
  const casingOpacity = (k: number) =>
    [
      'interpolate',
      ['linear'],
      ['zoom'],
      HEAT_CROSSFADE[0],
      ['*', heatLineOpacity(HEAT_CROSSFADE[0]) * k, strength],
      HEAT_CROSSFADE[1],
      ['*', k, strength],
    ] as never;
  return {
    glow: (
      <Layer
        id="tracks-heat-glow"
        key={`glow-${tone}`}
        beforeId={HEAT_ANCHOR}
        type="heatmap"
        maxzoom={HEAT_CROSSFADE[1]}
        paint={{
          'heatmap-weight': [
            '+',
            HEAT_GLOW_BASE_WEIGHT,
            ['/', ['log2', ['max', 1, ['get', 'count']]], 4],
          ] as never,
          'heatmap-intensity': HEAT_GLOW_INTENSITY,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            ...heatGlowColorStops(glowRamp).flatMap(([d, c, a]) => [d, rgba(c, a)]),
          ] as never,
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            ...HEAT_GLOW_RADIUS_STOPS.flat(),
          ] as never,
          'heatmap-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            HEAT_CROSSFADE[0],
            heatGlowOpacity(HEAT_CROSSFADE[0]),
            HEAT_CROSSFADE[1],
            0,
          ] as never,
        }}
      />
    ),
    lines: [
      <Layer
        id="tracks-heat-lines-casing"
        key={`casing-${tone}`}
        beforeId={HEAT_ANCHOR}
        type="line"
        minzoom={HEAT_CROSSFADE[0] - 1}
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{
          'line-color': outline.color,
          'line-width': lineWidth(outline.widthAdd),
          'line-opacity': casingOpacity(outline.opacity),
          'line-blur': 0.5,
        }}
      />,
      <Layer
        id="tracks-heat-lines"
        key={`lines-${tone}`}
        beforeId={HEAT_ANCHOR}
        type="line"
        minzoom={HEAT_CROSSFADE[0] - 1}
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{
          'line-color': [
            'step',
            ['get', 'count'],
            first?.[1] ?? '#F28E2B',
            ...rest.flatMap(([count, color]) => [count, color]),
          ] as never,
          'line-width': lineWidth(0),
          'line-opacity': lineOpacity(1),
        }}
      />,
    ],
  };
}

/**
 * Per ground: the light ramp on the paper map, the dark ramp on the night
 * map and on satellite imagery (dark in both themes), each with its outline.
 */
export const HEAT_LAYERS = {
  paper: heatLayers(HEAT_LINE_RAMP_LIGHT, HEAT_RAMP_LIGHT, 'paper'),
  night: heatLayers(HEAT_LINE_RAMP_DARK, HEAT_RAMP_DARK, 'night'),
  imagery: heatLayers(HEAT_LINE_RAMP_DARK, HEAT_RAMP_DARK, 'imagery'),
} as const;

/** A trail line over its outline, both under one filter (arrays: see the note above). */
function outlinedTrailLayers(
  id: string,
  width: number,
  tone: LineOutline,
  filter?: boolean,
): ReactElement[] {
  const outline = LINE_OUTLINE[tone];
  const shared = {
    beforeId: TRAIL_LINES_ANCHOR,
    type: 'line' as const,
    layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
    ...(filter === undefined ? {} : { filter }),
  };
  return [
    <Layer
      key="casing"
      id={`${id}-casing`}
      {...shared}
      paint={{
        'line-color': outline.color,
        'line-width': width + outline.widthAdd,
        'line-opacity': outline.opacity,
        'line-blur': 0.5,
      }}
    />,
    <Layer
      key="line"
      id={id}
      {...shared}
      paint={{ 'line-color': ['get', 'color'], 'line-width': width }}
    />,
  ];
}

function trackLineSet(tone: LineOutline) {
  return {
    shown: outlinedTrailLayers('tracks-lines-layer', 3, tone, true),
    hidden: outlinedTrailLayers('tracks-lines-layer', 3, tone, false),
  };
}

/** Trail lines per ground, one element set per `filter` value (see the selection rule). */
export const TRACKS_LINES_LAYERS = {
  paper: trackLineSet('paper'),
  night: trackLineSet('night'),
  imagery: trackLineSet('imagery'),
} as const;

/** The focused trail's highlight per ground. */
export const FOCUSED_TRAIL_LAYERS = {
  paper: outlinedTrailLayers('focused-trail-line-layer', 4, 'paper'),
  night: outlinedTrailLayers('focused-trail-line-layer', 4, 'night'),
  imagery: outlinedTrailLayers('focused-trail-line-layer', 4, 'imagery'),
} as const;

export const INSPECT_MARKER_LAYER = (
  <Layer
    id="inspect-marker-dot"
    beforeId={MARKERS_ANCHOR}
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
    beforeId={TRAIL_LINES_ANCHOR}
    type="line"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': mapColors.trailCasing, 'line-width': 9 }}
  />,
  <Layer
    key="line"
    id="trail-line"
    beforeId={TRAIL_LINES_ANCHOR}
    type="line"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': mapColors.trail, 'line-width': 5 }}
  />,
];

/**
 * On-device contour layers per basemap (the raster fallback: map maker open,
 * or the vector flag off; the vector bases draw served contours in the
 * style). In the contours slot, under the PDF maps (#492).
 */
function contourLayers(satellite: boolean) {
  return {
    minor: [
      <Layer
        key="halo"
        id="contours2d-minor-halo"
        beforeId={DEM_CONTOURS_ANCHOR}
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
        beforeId={DEM_CONTOURS_ANCHOR}
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
        beforeId={DEM_CONTOURS_ANCHOR}
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
        beforeId={DEM_CONTOURS_ANCHOR}
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

/**
 * Contours over the vector Stone & Paper base: the board's warm ochre
 * isolines, no halo (the paper and the night ground are calm enough), major
 * lines stronger. Night keeps the hue and drops the opacity.
 */
function stoneContourLayers(dark: boolean) {
  return {
    minor: [
      <Layer
        key="line"
        id="contours2d-minor-line"
        beforeId={DEM_CONTOURS_ANCHOR}
        type="line"
        paint={{
          'line-color': palette.ochre,
          'line-opacity': dark ? 0.4 : 0.55,
          'line-width': 0.8,
        }}
      />,
    ],
    major: [
      <Layer
        key="line"
        id="contours2d-major-line"
        beforeId={DEM_CONTOURS_ANCHOR}
        type="line"
        paint={{ 'line-color': palette.ochre, 'line-opacity': dark ? 0.6 : 0.8, 'line-width': 1.4 }}
      />,
    ],
  } as const;
}

export const CONTOUR_LAYERS = {
  satellite: contourLayers(true),
  plain: contourLayers(false),
  stoneLight: stoneContourLayers(false),
  stoneDark: stoneContourLayers(true),
} as const;

/**
 * PDF overview raster (#332): above the contours, the relief and the slope
 * raster on both base maps (#492), below trails and the puck.
 */
export function pdfOverviewLayer(id: string) {
  return (
    <Layer
      id={`${id}-layer`}
      type="raster"
      beforeId={PDF_MAP_ANCHOR}
      paint={{ 'raster-opacity': 0.92 }}
    />
  );
}

/** PDF detail tile raster (#332): same slot as the overview it refines. */
export function pdfDetailLayer(id: string) {
  return (
    <Layer
      id={`${id}-layer`}
      type="raster"
      beforeId={PDF_MAP_ANCHOR}
      paint={{ 'raster-opacity': 1, 'raster-fade-duration': 0 }}
    />
  );
}

/**
 * Slope-angle raster: over the relief, under the names and the PDF maps
 * (#492 — a PDF map is the more specific source wherever it covers).
 * Resampled LINEARLY (#461): the image has fewer pixels than the screen, and
 * 'nearest' drew each one as a hard-edged block — the stepped look the owner
 * reported. Linear blends band edges over a pixel, which is all it changes.
 */
export const SLOPE_RASTER_PAINT = {
  'raster-opacity': 0.62,
  'raster-resampling': 'linear',
} as const;

export const SLOPE_LAYER = (
  <Layer id="slope2d-layer" type="raster" beforeId={SLOPE_ANCHOR} paint={SLOPE_RASTER_PAINT} />
);

/**
 * Drives the style's hidden tilted-map relief pass (#480): a component
 * `<Layer>` with the SAME id as the style layer, which both native sides
 * ADOPT rather than duplicate (MLRNLayer.addToMap / MLRNLayer.m look the id
 * up first), then set only these properties on. Keep it mounted for as long
 * as the style has the pass ({@link styleHasTiltRelief}): unmounting removes
 * the style layer itself until the next style reload. Flat, it is hidden, so
 * it costs no extra hillshade pass.
 *
 * ONLY visibility and exaggeration are set here, never colours or the light:
 * the wrapper's Android setters read the shadow/highlight colours as string
 * ARRAYS and the direction as a float array (this MapLibre Native's
 * multidirectional hillshade). Found on the emulator: a plain colour or a
 * scalar direction threw "cannot be cast" and killed the React instance, and
 * no expression yields the `array<color>` type the core then demands. The
 * style JSON carries those instead.
 */
export function tiltReliefLayer(exaggeration: number) {
  return (
    <Layer
      id={TILT_RELIEF_LAYER_ID}
      type="hillshade"
      source={HILLSHADE_DEM_SOURCE_ID}
      // Top of the relief slot: right above the base shading on the map,
      // and the slot's only layer on satellite (#492), which has no base
      // shading to sit after. Native adopts the style's own layer by id, so
      // this only matters if the style ever lacked it.
      beforeId={RELIEF_TOP_ANCHOR}
      minzoom={HILLSHADE_2D_MIN_ZOOM}
      layout={{ visibility: exaggeration > 0 ? 'visible' : 'none' }}
      paint={{
        // The base's zoom fade-in (#230), up to the pitch's exaggeration.
        'hillshade-exaggeration': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HILLSHADE_2D_MIN_ZOOM,
          0,
          HILLSHADE_2D_MIN_ZOOM + 1,
          exaggeration,
        ],
      }}
    />
  );
}
