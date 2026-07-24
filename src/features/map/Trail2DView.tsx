import type { TrackNote, TrackPoint } from '@core/models';
import type { TrackPointAt } from '@core/geo/track';
import { numberNotesOnTrack } from '@core/library/notes';
import { bboxFromLngLats } from '@core/geo/geomath';
import { useSettingsStore } from '@state/settingsStore';
import { useMapStore, type MapBasemap } from '@state/mapStore';
import { mapColors } from '@ui/theme';
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  type MapRef,
  Marker,
} from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { buildOsmStyle } from './mapStyle';
import { toLngLatBounds } from './geojson';
import { NoteNumberBadge } from './components/NoteNumberBadge';

export function Trail2DView({
  points,
  notes,
  scrubAt,
  basemap,
  onNotePress,
}: {
  points: readonly TrackPoint[];
  notes?: readonly TrackNote[];
  /** Elevation-profile scrub position: draws a marker riding the 2D trace. */
  scrubAt?: TrackPointAt | null;
  /** Viewer-local basemap from the trail rail; falls back to the main map's. */
  basemap?: MapBasemap;
  /** Called with the note id when a numbered pin is tapped. */
  onNotePress?: (noteId: string) => void;
}) {
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const mainBasemap = useMapStore((s) => s.basemap);
  const bm = basemap ?? mainBasemap;
  const style = useMemo(() => buildOsmStyle(tileUrl, false, bm, true), [tileUrl, bm]);
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);

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

  // Notes numbered 1..N in trail order — the SAME numbering the notes list and
  // the elevation-profile pins use (both go through orderNotes), so a pin on
  // the map is trivially matched to its row in the list.
  const numberedNotes = useMemo(() => numberNotesOnTrack(points, notes ?? []), [points, notes]);

  // Scrub marker (see MapScreen's inspect-marker: same shape and colours).
  const scrubFeature = useMemo(
    () =>
      scrubAt
        ? {
            type: 'Feature' as const,
            geometry: {
              type: 'Point' as const,
              coordinates: [scrubAt.longitude, scrubAt.latitude],
            },
            properties: {},
          }
        : null,
    [scrubAt],
  );

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

  // Pin taps are hit-tested at the MAP level, same as MapScreen's waypoint
  // pins: <Marker onPress> doesn't fire on Android, and a Pressable child
  // proved unreliable across devices too. The tap's pixel point is compared
  // against each pin projected through the real camera.
  const NOTE_HIT_PX = 48;
  const onMapPress = useCallback(
    async (e: { nativeEvent?: { point?: [number, number] } }) => {
      const point = e.nativeEvent?.point;
      const map = mapRef.current;
      if (!onNotePress || !point || !map || numberedNotes.length === 0) return;
      const [px, py] = point;
      let bestId: string | null = null;
      let bestD = NOTE_HIT_PX;
      try {
        const pts = await Promise.all(
          numberedNotes.map((n) => map.project([n.longitude, n.latitude])),
        );
        for (let i = 0; i < numberedNotes.length; i++) {
          const p = pts[i];
          if (!p) continue;
          const d = Math.hypot(px - p[0], py - p[1]);
          if (d < bestD) {
            bestD = d;
            bestId = numberedNotes[i]!.note.id;
          }
        }
      } catch {
        return; // projection unavailable mid-teardown — ignore the tap
      }
      if (bestId) onNotePress(bestId);
    },
    [numberedNotes, onNotePress],
  );

  return (
    <Map
      ref={mapRef}
      style={styles.fill}
      mapStyle={style}
      compass={false}
      onDidFinishLoadingMap={fitToTrail}
      onPress={onMapPress}
    >
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

      {/* Scrub marker: rides the trace as the elevation profile is scrubbed. */}
      {scrubFeature && (
        <GeoJSONSource id="trail-2d-scrub" data={scrubFeature}>
          <Layer
            id="trail-2d-scrub-dot"
            type="circle"
            paint={{
              'circle-radius': 7,
              'circle-color': mapColors.userLocation,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            }}
          />
        </GeoJSONSource>
      )}

      {/* Numbered note pins. Markers (RN views), not a symbol layer: the raster
          style declares no glyphs endpoint, so MapLibre text would not render.
          Visual only — taps land through onMapPress's hit-test above. */}
      {numberedNotes.map((n) => (
        <Marker
          key={n.note.id}
          id={`trail-2d-note-${n.note.id}`}
          lngLat={[n.longitude, n.latitude]}
          anchor="center"
        >
          <NoteNumberBadge num={n.num} />
        </Marker>
      ))}
    </Map>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
