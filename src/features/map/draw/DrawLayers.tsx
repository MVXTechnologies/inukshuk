import { TRAILS_ANCHOR } from '@core/geo/mapLayerStack';
import { midpointHandles } from '@core/draw/geometry';
import type { DrawKind } from '@core/draw/editor';
import type { LngLat } from '@core/models';
import {
  GeoJSONSource,
  Layer,
  ViewAnnotation,
  type ViewAnnotationEvent,
} from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native';

/**
 * The shape being drawn (#502 route / #503 area), as MapView children: the
 * line (or the polygon's fill + outline) and one draggable handle per vertex
 * plus a smaller "insert" handle on every segment's middle.
 *
 * Handles are native `ViewAnnotation`s with `draggable`: MapLibre moves them
 * under the finger itself (no per-frame bridge round-trip to reposition a
 * View), reports `onDrag` so the line follows live, and `onDragEnd` commits
 * the edit. A tap on a handle is consumed by the annotation (it never reaches
 * the map's own tap handler), which is what lets a tap on a vertex select it
 * instead of adding a new point on top of it.
 *
 * Every committed edit bumps `revision`, which re-keys the handles: a dragged
 * annotation's native position and its React `lngLat` can otherwise disagree
 * after a drag the reducer rejected (or turned into an insert).
 */

export interface DrawHandleCallbacks {
  onVertexPress: (index: number) => void;
  onVertexDrag: (index: number, at: LngLat) => void;
  onVertexDragEnd: (index: number, at: LngLat) => void;
  onMidpointPress: (insertAt: number, at: LngLat) => void;
  onMidpointDrag: (insertAt: number, at: LngLat) => void;
  onMidpointDragEnd: (insertAt: number, at: LngLat) => void;
}

interface Props extends DrawHandleCallbacks {
  kind: DrawKind;
  /** What to draw, with an in-flight drag applied. */
  shown: readonly LngLat[];
  /** The committed vertices (handle positions). */
  vertices: readonly LngLat[];
  selected: number | null;
  revision: number;
  /** Line colour (route) / fill + outline colour (area). */
  color: string;
  /** Halo under the route line, and the handles' paper fill. */
  halo: string;
  /** Handle ink (inner points). */
  ink: string;
  /** The selected handle's ring. */
  selectedColor: string;
}

const lngLatOf = (e: NativeSyntheticEvent<ViewAnnotationEvent>): LngLat | null => {
  const ll = e.nativeEvent?.lngLat;
  return Array.isArray(ll) && ll.length >= 2 ? [ll[0], ll[1]] : null;
};

/** The GeoJSON for the drawn shape: a line, or a polygon once it has 3 corners. */
export function drawShapeGeoJson(kind: DrawKind, shown: readonly LngLat[]) {
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
  return { type: 'FeatureCollection', features };
}

export function DrawLayers(props: Props) {
  const { kind, shown, vertices, selected, revision, color, halo, ink, selectedColor } = props;
  const data = useMemo(() => JSON.stringify(drawShapeGeoJson(kind, shown)), [kind, shown]);
  const mids = useMemo(() => midpointHandles(vertices, kind === 'area'), [vertices, kind]);

  const layers =
    kind === 'route'
      ? [
          <Layer
            key="casing"
            id="draw-route-casing"
            beforeId={TRAILS_ANCHOR}
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': halo, 'line-width': 8 }}
          />,
          <Layer
            key="line"
            id="draw-route-line"
            beforeId={TRAILS_ANCHOR}
            type="line"
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
            filter={['==', ['get', 'role'], 'fill']}
            paint={{ 'fill-color': color, 'fill-opacity': 0.18 }}
          />,
          <Layer
            key="line"
            id="draw-area-line"
            beforeId={TRAILS_ANCHOR}
            type="line"
            filter={['==', ['get', 'role'], 'line']}
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{ 'line-color': color, 'line-width': 2.5 }}
          />,
        ];

  return (
    <>
      <GeoJSONSource id="draw-shape" data={data}>
        {layers}
      </GeoJSONSource>
      {mids.map((m) => (
        <ViewAnnotation
          key={`mid-${m.insertAt}-${revision}`}
          id={`draw-mid-${m.insertAt}-${revision}`}
          lngLat={m.at}
          draggable
          onPress={() => props.onMidpointPress(m.insertAt, m.at)}
          onDrag={(e) => {
            const at = lngLatOf(e);
            if (at) props.onMidpointDrag(m.insertAt, at);
          }}
          onDragEnd={(e) => {
            const at = lngLatOf(e);
            if (at) props.onMidpointDragEnd(m.insertAt, at);
          }}
        >
          <View style={styles.midHit} collapsable={false}>
            <View style={[styles.mid, { backgroundColor: halo, borderColor: color }]} />
          </View>
        </ViewAnnotation>
      ))}
      {vertices.map((v, i) => {
        const isSelected = selected === i;
        const isStart = kind === 'route' && i === 0;
        const isEnd = kind === 'route' && i === vertices.length - 1 && i > 0;
        const dot =
          kind === 'area'
            ? { backgroundColor: halo, borderColor: color }
            : isStart
              ? { backgroundColor: halo, borderColor: ink }
              : isEnd
                ? { backgroundColor: ink, borderColor: halo }
                : { backgroundColor: ink, borderColor: ink };
        return (
          <ViewAnnotation
            key={`v-${i}-${revision}`}
            id={`draw-v-${i}-${revision}`}
            lngLat={v}
            draggable
            onPress={() => props.onVertexPress(i)}
            onDrag={(e) => {
              const at = lngLatOf(e);
              if (at) props.onVertexDrag(i, at);
            }}
            onDragEnd={(e) => {
              const at = lngLatOf(e);
              if (at) props.onVertexDragEnd(i, at);
            }}
          >
            <View style={styles.hit} collapsable={false}>
              {isSelected && <View style={[styles.ring, { borderColor: selectedColor }]} />}
              <View
                style={[
                  isStart || isEnd ? styles.endDot : styles.dot,
                  dot,
                  isSelected && { borderColor: selectedColor },
                ]}
              />
            </View>
          </ViewAnnotation>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  // The bitmap IS the touch target: a finger-sized transparent square.
  hit: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2.5 },
  endDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3 },
  ring: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
  },
  midHit: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  mid: { width: 11, height: 11, borderRadius: 6, borderWidth: 2, opacity: 0.9 },
});
