import type { TrackNote, TrackPoint } from '@core/models';
import { interpolateTrackAtDistance } from '@core/geo/track';
import { bboxFromLngLats } from '@core/geo/geomath';
import { useSettingsStore } from '@state/settingsStore';
import { useMapStore } from '@state/mapStore';
import { Camera, type CameraRef, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { buildOsmStyle } from './mapStyle';
import { toLngLatBounds } from './geojson';

export function Trail2DView({
  points,
  notes,
}: {
  points: readonly TrackPoint[];
  notes?: readonly TrackNote[];
}) {
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const basemap = useMapStore((s) => s.basemap);
  const style = useMemo(() => buildOsmStyle(tileUrl, false, basemap, true), [tileUrl, basemap]);
  const cameraRef = useRef<CameraRef>(null);

  const lngLats = useMemo(
    () => points.map((p) => [p.longitude, p.latitude] as [number, number]),
    [points],
  );

  const lineFeature = useMemo(
    () => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: lngLats },
      properties: {},
    }),
    [lngLats],
  );

  const notesFeature = useMemo(() => {
    const feats = (notes ?? [])
      .map((n) => {
        const at = interpolateTrackAtDistance(points, n.distanceM);
        if (!at) return null;
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [at.longitude, at.latitude] },
          properties: { label: n.text },
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);
    return { type: 'FeatureCollection' as const, features: feats };
  }, [notes, points]);

  const bbox = useMemo(() => (lngLats.length >= 1 ? bboxFromLngLats(lngLats) : null), [lngLats]);

  // Fit the camera to the trail. Must run once the map is loaded (the camera ref
  // is a no-op before then), so we also call it from onDidFinishLoadingMap — not
  // only from this effect, which fires on mount before the map is ready.
  const fitToTrail = useCallback(() => {
    if (!bbox) return;
    cameraRef.current?.fitBounds(toLngLatBounds(bbox), {
      duration: 0,
      padding: { top: 60, right: 40, bottom: 60, left: 40 },
    });
  }, [bbox]);

  useEffect(() => {
    fitToTrail();
  }, [fitToTrail]);

  return (
    <Map style={styles.fill} mapStyle={style} compass={false} onDidFinishLoadingMap={fitToTrail}>
      <Camera ref={cameraRef} />
      <GeoJSONSource id="trail-2d" data={lineFeature}>
        <Layer
          id="trail-2d-casing"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': '#FFFFFF', 'line-width': 5, 'line-opacity': 0.7 }}
        />
        <Layer
          id="trail-2d-line"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': '#E0312B', 'line-width': 2.6, 'line-opacity': 0.96 }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="trail-2d-notes" data={notesFeature}>
        <Layer
          id="trail-2d-notes-pin"
          type="circle"
          paint={{
            'circle-radius': 6,
            'circle-color': '#2D3740',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#FFFFFF',
          }}
        />
      </GeoJSONSource>
    </Map>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
