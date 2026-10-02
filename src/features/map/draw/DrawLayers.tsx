import { TRAILS_ANCHOR } from '@core/geo/mapLayerStack';
import { midpointHandles, type MidpointHandle } from '@core/draw/geometry';
import type { DrawKind } from '@core/draw/editor';
import { halfwayAlong, type LegView } from '@core/draw/legs';
import type { LngLat } from '@core/models';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';

/**
 * The shape being drawn (#502 route / #503 area), as MapView children: the
 * line (or the polygon's fill + outline), a dot per vertex and a small open
 * "insert" dot on every segment's middle — all one GeoJSON source.
 *
 * The handles are plain circle layers, not native annotations: a native
 * draggable annotation never received the finger on Android (the map's own
 * gestures won), so taps are hit-tested in JS (`@core/draw/hitTest`) and a
 * selected vertex is dragged through an RN overlay (`DragHandle`).
 *
 * A route is drawn leg by leg (#515): a leg snapped to trails or roads is a
 * solid line (it is real ground); a Freehand leg, or one still being routed,
 * is dashed (a plan); a leg that could not be routed is dashed in amber with
 * a warning dot on its middle.
 */

interface Props {
  kind: DrawKind;
  /** What to draw, with an in-flight drag applied. */
  shown: readonly LngLat[];
  selected: number | null;
  /** Line colour (route) / fill + outline colour (area). */
  color: string;
  /** Halo under the route line, and the handles' paper fill. */
  halo: string;
  /** Handle ink (route points). */
  ink: string;
  /** The selected handle's ring. */
  selectedColor: string;
  /** A route's legs as drawn (routed or straight); without them, one straight line. */
  legs?: readonly LegView[];
  /** Insert handles; default: the straight segments' middles. */
  mids?: readonly MidpointHandle[];
  /** Failed legs' line and warning dot. */
  warnColor?: string;
  /** The point scrubbed on the elevation profile: a marker on the line. */
  scrubAt?: LngLat | null;
}

/** The GeoJSON for the drawn shape and its handles. */
export function drawShapeGeoJson(
  kind: DrawKind,
  shown: readonly LngLat[],
  selected: number | null = null,
  legs?: readonly LegView[],
  mids?: readonly MidpointHandle[],
  scrubAt: LngLat | null = null,
) {
  const coords = shown.map((p) => [p[0], p[1]]);
  const first = coords[0];
  const features: object[] = [];
  if (kind === 'area' && shown.length >= 3 && first) {
    features.push({
      type: 'Feature',
      properties: { role: 'fill' },
      geometry: { type: 'Polygon', coordinates: [[...coords, first]] },
    });
    features.push({
      type: 'Feature',
      properties: { role: 'line' },
      geometry: { type: 'LineString', coordinates: [...coords, first] },
    });
  } else if (kind === 'route' && legs !== undefined) {
    for (const leg of legs) {
      features.push({
        type: 'Feature',
        properties: { role: 'line', leg: leg.status },
        geometry: { type: 'LineString', coordinates: leg.coords.map((p) => [p[0], p[1]]) },
      });
      const mid = leg.status === 'failed' ? halfwayAlong(leg.coords) : null;
      if (mid !== null) {
        features.push({
          type: 'Feature',
          properties: { role: 'warn' },
          geometry: { type: 'Point', coordinates: [mid[0], mid[1]] },
        });
      }
    }
  } else if (shown.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { role: 'line', leg: 'straight' },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  for (const m of mids ?? midpointHandles(shown, kind === 'area')) {
    features.push({
      type: 'Feature',
      properties: { role: 'mid' },
      geometry: { type: 'Point', coordinates: [m.at[0], m.at[1]] },
    });
  }
  shown.forEach((p, i) => {
    const end =
      kind === 'route' ? (i === 0 ? 'start' : i === shown.length - 1 ? 'end' : 'inner') : 'corner';
    features.push({
      type: 'Feature',
      properties: { role: 'vertex', end, selected: i === selected },
      geometry: { type: 'Point', coordinates: [p[0], p[1]] },
    });
  });
  if (scrubAt !== null) {
    features.push({
      type: 'Feature',
      properties: { role: 'scrub' },
      geometry: { type: 'Point', coordinates: [scrubAt[0], scrubAt[1]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

const role = (r: string) => ['==', ['get', 'role'], r] as never;

const legIs = (...states: string[]) =>
  ['all', role('line'), ['in', ['get', 'leg'], ['literal', states]]] as never;

export function DrawLayers({
  kind,
  shown,
  selected,
  color,
  halo,
  ink,
  selectedColor,
  legs,
  mids,
  warnColor = color,
  scrubAt = null,
}: Props) {
  const data = useMemo(
    () => JSON.stringify(drawShapeGeoJson(kind, shown, selected, legs, mids, scrubAt)),
    [kind, shown, selected, legs, mids, scrubAt],
  );
  const shape =
    kind === 'route'
      ? [
          <Layer
            key="casing"
            id="draw-route-casing"
            beforeId={TRAILS_ANCHOR}
            type="line"
            filter={role('line')}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': halo, 'line-width': 8 }}
          />,
          <Layer
            key="line"
            id="draw-route-line"
            beforeId={TRAILS_ANCHOR}
            type="line"
            filter={legIs('straight', 'loading')}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            // Freehand reads as a plan, not a recorded trace: dashed. A leg
            // still being routed shows the same way until it snaps.
            paint={{ 'line-color': color, 'line-width': 4.5, 'line-dasharray': [2.2, 1.4] }}
          />,
          <Layer
            key="routed"
            id="draw-route-routed"
            beforeId={TRAILS_ANCHOR}
            type="line"
            filter={legIs('routed')}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': color, 'line-width': 4.5 }}
          />,
          <Layer
            key="failed"
            id="draw-route-failed"
            beforeId={TRAILS_ANCHOR}
            type="line"
            filter={legIs('failed')}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': warnColor, 'line-width': 4.5, 'line-dasharray': [1.2, 1.2] }}
          />,
          <Layer
            key="warn"
            id="draw-route-warn"
            beforeId={TRAILS_ANCHOR}
            type="circle"
            filter={role('warn')}
            paint={{
              'circle-radius': 8,
              'circle-color': warnColor,
              'circle-stroke-width': 2.5,
              'circle-stroke-color': halo,
            }}
          />,
        ]
      : [
          <Layer
            key="fill"
            id="draw-area-fill"
            beforeId={TRAILS_ANCHOR}
            type="fill"
            filter={role('fill')}
            paint={{ 'fill-color': color, 'fill-opacity': 0.18 }}
          />,
          <Layer
            key="line"
            id="draw-area-line"
            beforeId={TRAILS_ANCHOR}
            type="line"
            filter={role('line')}
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{ 'line-color': color, 'line-width': 2.5 }}
          />,
        ];
  const isEnd = ['in', ['get', 'end'], ['literal', ['start', 'end']]];
  const fill = kind === 'area' ? halo : ['match', ['get', 'end'], 'start', halo, 'end', ink, ink];
  const stroke =
    kind === 'area' ? color : ['match', ['get', 'end'], 'start', ink, 'end', halo, ink];
  const handles = [
    <Layer
      key="mid"
      id="draw-handle-mid"
      beforeId={TRAILS_ANCHOR}
      type="circle"
      filter={role('mid')}
      paint={{
        'circle-radius': 5,
        'circle-color': halo,
        'circle-opacity': 0.9,
        'circle-stroke-width': 2,
        'circle-stroke-color': color,
      }}
    />,
    <Layer
      key="ring"
      id="draw-handle-ring"
      beforeId={TRAILS_ANCHOR}
      type="circle"
      filter={['all', role('vertex'), ['==', ['get', 'selected'], true]] as never}
      paint={{
        'circle-radius': 15,
        'circle-color': 'transparent',
        'circle-stroke-width': 3,
        'circle-stroke-color': selectedColor,
      }}
    />,
    <Layer
      key="vertex"
      id="draw-handle-vertex"
      beforeId={TRAILS_ANCHOR}
      type="circle"
      filter={role('vertex')}
      paint={{
        'circle-radius': (kind === 'route' ? ['case', isEnd, 8, 6.5] : 6.5) as never,
        'circle-color': fill as never,
        'circle-stroke-width': (kind === 'route' ? ['case', isEnd, 3, 0] : 2.5) as never,
        'circle-stroke-color': stroke as never,
      }}
    />,
  ];
  const scrub = (
    <Layer
      key="scrub"
      id="draw-scrub"
      beforeId={TRAILS_ANCHOR}
      type="circle"
      filter={role('scrub')}
      paint={{
        'circle-radius': 9,
        'circle-color': ink,
        'circle-stroke-width': 3,
        'circle-stroke-color': halo,
      }}
    />
  );
  return (
    <GeoJSONSource id="draw-shape" data={data}>
      {[...shape, ...handles, scrub]}
    </GeoJSONSource>
  );
}
