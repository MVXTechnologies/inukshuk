import type { TrackNote, TrackPoint } from '@core/models';
import type { TrackPointAt } from '@core/geo/track';
import { splitSegments } from '@core/geo/track/segments';
import { numberNotesOnTrack } from '@core/library/notes';
import { bboxFromLngLats } from '@core/geo/geomath';
import { useSettingsStore } from '@state/settingsStore';
import { useMapStore, type MapBasemap } from '@state/mapStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
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
import { VECTOR_BASEMAP_ENABLED } from '@core/features/flags';
import { vectorBasemapOption } from '@data/basemapTiles';
import { useTheme } from 'react-native-paper';
import { buildOsmStyle } from './mapStyle';
import { toLngLatBounds } from './geojson';
import { NoteNumberBadge } from './components/NoteNumberBadge';
import { useTiltRelief } from './hooks/useTiltRelief';

export function Trail2DView({
  points,
  segmentStarts,
  notes,
  scrubAt,
  basemap,
  onNotePress,
  focus,
}: {
  points: readonly TrackPoint[];
  /** Recording segment boundaries (pauses) — the trace is not drawn across them. */
  segmentStarts?: readonly number[];
  notes?: readonly TrackNote[];
  /** Elevation-profile scrub position: draws a marker riding the 2D trace. */
  scrubAt?: TrackPointAt | null;
  /** Viewer-local basemap from the trail rail; falls back to the main map's. */
  basemap?: MapBasemap;
  /** Called with the note id when a numbered pin is tapped. */
  onNotePress?: (noteId: string) => void;
  /**
   * Centre the camera here (keeping the zoom) — a Timeline item or jump chip
   * was tapped (#511). A new object re-centres even on the same spot.
   */
  focus?: { latitude: number; longitude: number } | null;
}) {
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  // Same platform-defaulted switch the main map obeys (#230) — a setting the
  // user turned off must not come back on the trail viewer's own 2D map.
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  const mainBasemap = useMapStore((s) => s.basemap);
  const bm = basemap ?? mainBasemap;
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const contours = useSettingsStore((s) => s.terrainContours);
  // The main map's shading strength and "3D relief" (#461/#480): the focused
  // view tilts with two fingers like the main map (owner call, #480 — its
  // three.js 3D button is gone), so it deepens the relief the same way.
  const hillshadeStrength = useSettingsStore((s) => s.hillshadeStrength);
  const tiltRelief = useSettingsStore((s) => s.tiltRelief);
  // The Stone & Paper vector map here too (flag-gated), with served contours.
  const style = useMemo(
    () =>
      buildOsmStyle(tileUrl, false, bm, showHillshade, {
        ...(VECTOR_BASEMAP_ENABLED && bm === 'map'
          ? { vectorBasemap: vectorBasemapOption(theme.dark, contours) }
          : {}),
        hillshadeStrength,
        tiltRelief,
      }),
    [tileUrl, bm, showHillshade, theme.dark, contours, hillshadeStrength, tiltRelief],
  );
  const tilt = useTiltRelief(style);
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);

  const lngLats = useMemo(
    () => points.map((p) => [p.longitude, p.latitude] as [number, number]),
    [points],
  );

  // One part per recording segment: a pause (drive to the next trailhead,
  // lunch off-trail) must not be drawn as a straight line across the map.
  const lineFeature = useMemo(() => {
    const parts = splitSegments(lngLats, segmentStarts ?? []);
    return {
      type: 'Feature' as const,
      geometry:
        parts.length > 1
          ? { type: 'MultiLineString' as const, coordinates: parts }
          : { type: 'LineString' as const, coordinates: lngLats },
      properties: {},
    };
  }, [lngLats, segmentStarts]);

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
      // Top clears the floating title card (#511), right the layer rail.
      padding: { top: 110, right: 64, bottom: 36, left: 36 },
    });
  }, [bbox]);

  useEffect(() => {
    fitToTrail();
  }, [fitToTrail]);

  useEffect(() => {
    if (!focus) return;
    cameraRef.current?.easeTo({ center: [focus.longitude, focus.latitude], duration: 450 });
  }, [focus]);

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
      // Two-finger tilt, as on the main map (#480). MapLibre's default, but
      // explicit: it is now the ONLY way into a 3D-ish view here.
      touchPitch
      onDidFinishLoadingMap={fitToTrail}
      onDidFinishLoadingStyle={tilt.onStyleLoaded}
      onRegionDidChange={(e) => tilt.onSettledPitch(e.nativeEvent.pitch)}
      onPress={onMapPress}
    >
      <Camera ref={cameraRef} />
      {tilt.layer}
      <GeoJSONSource id="trail-2d" data={lineFeature}>
        {/* Orange route on a paper halo (#511, the explorer's trail ink):
            reads on the map, the hillshade and satellite alike. */}
        <Layer
          id="trail-2d-casing"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': tokens.explore.trailHalo, 'line-width': 8, 'line-opacity': 0.9 }}
        />
        <Layer
          id="trail-2d-line"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': tokens.explore.trail, 'line-width': 4.5 }}
        />
      </GeoJSONSource>

      {/* Scrub marker: rides the trace as the elevation profile is scrubbed. */}
      {scrubFeature && (
        <GeoJSONSource id="trail-2d-scrub" data={scrubFeature}>
          <Layer
            id="trail-2d-scrub-dot"
            type="circle"
            paint={{
              'circle-radius': 8,
              'circle-color': tokens.inkVariant,
              'circle-stroke-width': 3,
              'circle-stroke-color': tokens.explore.trailHalo,
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
