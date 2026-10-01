import { TRAILS_ANCHOR } from '@core/geo/mapLayerStack';
import { midpointHandles } from '@core/draw/geometry';
import type { DrawKind } from '@core/draw/editor';
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
}

/** The GeoJSON for the drawn shape and its handles. */
export function drawShapeGeoJson(
  kind: DrawKind,
  shown: readonly LngLat[],
  selected: number | null = null,
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
  } else if (shown.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { role: 'line' },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  for (const m of midpointHandles(shown, kind === 'area')) {
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
  return { type: 'FeatureCollection', features };
}

const role = (r: string) => ['==', ['get', 'role'], r] as never;

export function DrawLayers({ kind, shown, selected, color, halo, ink, selectedColor }: Props) {
  const data = useMemo(
    () => JSON.stringify(drawShapeGeoJson(kind, shown, selected)),
    [kind, shown, selected],
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
            filter={role('line')}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            // Freehand reads as a plan, not a recorded trace: dashed.
            paint={{ 'line-color': color, 'line-width': 4.5, 'line-dasharray': [2.2, 1.4] }}
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
  return (
    <GeoJSONSource id="draw-shape" data={data}>
      {[...shape, ...handles]}
    </GeoJSONSource>
  );
}
