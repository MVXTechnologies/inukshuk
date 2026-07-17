import { buildDownloadedMask } from '@core/geo/downloadedMask';
import { offlinePackMaxZoom } from '@core/geo/tiles';
import type { LngLat, TrackPoint } from '@core/models';
import type { Feature, LineString } from 'geojson';
import { mapColors } from '@ui/theme';
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  ImageSource,
  Layer,
  Map,
  type MapRef,
  Marker,
  UserLocation,
} from '@maplibre/maplibre-react-native';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Banner, Snackbar, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RegionSelectOverlay } from './RegionSelectOverlay';
import { BackgroundLocationRationale } from './components/BackgroundLocationRationale';
import { CompassBadge } from './components/CompassBadge';
import { HeadingCone } from './components/HeadingCone';
import { MapActionsFab } from './components/MapActionsFab';
import { MapControlsRail } from './components/MapControlsRail';
import { RecordControls } from './components/RecordControls';
import { StatsHud } from './components/StatsHud';
import { TrailInspectPanel } from './components/TrailInspectPanel';
import { WaypointEditorDialog } from './components/WaypointEditorDialog';
import { WaypointMarkerPin } from './components/WaypointMarkerPin';
import { Terrain3DLiveView } from './Terrain3DLiveView';
import { toLineFeature } from './geojson';
import { useAutoPauseOnLocationLoss } from './hooks/useAutoPauseOnLocationLoss';
import { useCameraControls } from './hooks/useCameraControls';
import { useHeadingCamera } from './hooks/useHeadingCamera';
import { useOfflineDownload } from './hooks/useOfflineDownload';
import { useRecordingSession } from './hooks/useRecordingSession';
import { useTrailInspection } from './hooks/useTrailInspection';
import { buildOsmStyle } from './mapStyle';
import { overwriteWithTrim, saveTrimmedCopy } from './trimTrack';
import { useLocationTracking } from './useLocation';
import { usePdfOverlays } from './usePdfOverlay';
import { useTrackOverlays } from './useTrackOverlays';
import { useTimedSnackbar } from '../common/useTimedSnackbar';

// Live-recording line throttle: rebuilding the LineString on every GPS fix
// re-serializes the entire track so far and pushes it across the bridge each
// fix. Rebuild at most once per TRAIL_REBUILD_MS or every TRAIL_REBUILD_POINTS
// new fixes, whichever comes first.
const TRAIL_REBUILD_MS = 1000;
const TRAIL_REBUILD_POINTS = 5;

/**
 * Throttled `toLineFeature(points)`. Between rebuilds the previous feature
 * object is returned unchanged, so the GeoJSON source keeps a stable reference.
 * A trailing timer commits the newest points shortly after fixes stop arriving,
 * so the drawn line never visibly lags the GPS.
 */
function useThrottledLineFeature(points: readonly TrackPoint[]): Feature<LineString> | null {
  const [feature, setFeature] = useState<Feature<LineString> | null>(() => toLineFeature(points));
  const builtAtRef = useRef(0);
  const builtCountRef = useRef(points.length);

  useEffect(() => {
    const build = () => {
      builtAtRef.current = Date.now();
      builtCountRef.current = points.length;
      setFeature(toLineFeature(points));
    };
    if (points.length < builtCountRef.current) {
      // Track reset (recording stopped or restarted) — reflect it immediately.
      build();
      return;
    }
    if (points.length === builtCountRef.current) return;
    const sinceLast = Date.now() - builtAtRef.current;
    const newPoints = points.length - builtCountRef.current;
    if (newPoints >= TRAIL_REBUILD_POINTS || sinceLast >= TRAIL_REBUILD_MS) {
      build();
      return;
    }
    // Trailing flush: if no further fix arrives to trigger a rebuild, this
    // timer commits the pending points once the throttle window elapses.
    const timer = setTimeout(build, TRAIL_REBUILD_MS - sinceLast);
    return () => clearTimeout(timer);
  }, [points]);

  return feature;
}

export function MapScreen() {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);

  const tileUrl = useSettingsStore((s) => s.tileUrl);

  const { permission, location, unavailableReason } = useLocationTracking();
  const headingForCamera = useHeadingCamera();

  const maps = useLibraryStore((s) => s.maps);
  const tracks = useLibraryStore((s) => s.tracks);
  const addTrack = useLibraryStore((s) => s.addTrack);
  const updateTrack = useLibraryStore((s) => s.updateTrack);
  const { overlays, error: overlayError } = usePdfOverlays(maps);
  const trackOverlays = useTrackOverlays(tracks);

  const followUser = useMapStore((s) => s.followUser);
  const setFollowUser = useMapStore((s) => s.setFollowUser);
  const showPdfOverlay = useMapStore((s) => s.showPdfOverlay);
  const showTrackOverlays = useMapStore((s) => s.showTrackOverlays);
  const terrain3d = useMapStore((s) => s.terrain3d);
  const basemap = useMapStore((s) => s.basemap);
  const theme = useTheme();
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const offlineRegions = useOfflineStore((s) => s.regions);
  // 2D base style with shaded-relief hillshade for the outdoor/topo look;
  // hillshade-3D was replaced by the real 3D terrain surface.
  //
  // With "Locally downloaded only" on, the style also (a) caps the raster
  // source at the packs' top stored zoom so zooming past it overscales the
  // deepest downloaded tiles instead of going blank, and (b) masks everything
  // outside the downloaded regions with an opaque theme-matched fill (white in
  // light mode, the app background in dark mode) — downloaded areas show
  // through holes in the mask; trails/markers/location still draw on top.
  const style = useMemo(() => {
    const options = offlineOnly
      ? {
          rasterMaxZoom: offlinePackMaxZoom(offlineRegions, basemap),
          downloadedMask: {
            data: buildDownloadedMask(
              offlineRegions.filter((r) => r.basemap === basemap).map((r) => r.bounds),
            ),
            color: theme.dark ? theme.colors.background : '#FFFFFF',
          },
        }
      : {};
    return buildOsmStyle(tileUrl, false, basemap, true, options);
  }, [tileUrl, basemap, offlineOnly, offlineRegions, theme.dark, theme.colors.background]);

  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3000);

  // Overlay errors surface through the timed hook too: a raw <Snackbar
  // duration={4000}> never auto-dismisses on Samsung One UI (paper arms its
  // timer in an animation callback that may not fire), and its onDismiss was a
  // no-op — the error banner stuck on screen forever.
  const {
    message: overlaySnack,
    show: showOverlaySnack,
    dismiss: dismissOverlaySnack,
  } = useTimedSnackbar(4000);
  useEffect(() => {
    if (overlayError) showOverlaySnack(`Map overlay: ${overlayError}`);
  }, [overlayError, showOverlaySnack]);

  const {
    status,
    name,
    stats,
    points,
    waypoints,
    elapsedS,
    gpsQuality,
    pause,
    resume,
    startRecording,
    handleStop,
    addWaypoint,
    updateWaypoint,
    removeWaypoint,
    bgRationaleVisible,
    respondToBgRationale,
  } = useRecordingSession({ showSnack });

  // #90 — location lost mid-recording: auto-pause, but only on a SUSTAINED
  // loss (debounced in the hook; transient watch re-subscription and the
  // permission dialog's AppState churn must not pause a healthy recording).
  const locationLost = permission === 'denied' || unavailableReason !== null;
  useAutoPauseOnLocationLoss(locationLost, showSnack);

  const {
    selecting,
    downloadProgress,
    toGeo,
    boundsVersion,
    refreshBounds,
    onMapLayout,
    beginRegionSelect,
    cancelRegionSelect,
    confirmDownload,
  } = useOfflineDownload({ mapRef, cameraRef, showSnack });

  const { fitActiveMap, resetNorth } = useCameraControls({ cameraRef, overlays });

  const {
    inspectId,
    inspectTrack,
    inspectPoints,
    markerAt,
    setMarkerAt,
    inspect,
    trimRange,
    beginTrim,
    cancelTrim,
    changeTrim,
  } = useTrailInspection(tracks);

  // Trim tool: live preview segments + the two save paths. The kept window is
  // drawn bright over the trace; the cut ends are dimmed (see below).
  const [trimSaving, setTrimSaving] = useState(false);
  const trimPreview = useMemo(() => {
    if (!trimRange || !inspectPoints) return null;
    const { start, end } = trimRange;
    return {
      // Cut segments share their boundary point with the kept one — no gaps.
      cutHead: toLineFeature(inspectPoints.slice(0, start + 1)),
      kept: toLineFeature(inspectPoints.slice(start, end + 1)),
      cutTail: toLineFeature(inspectPoints.slice(end)),
    };
  }, [trimRange, inspectPoints]);

  const onSaveTrimCopy = useCallback(async () => {
    if (!inspectTrack || !inspectPoints || !trimRange) return;
    setTrimSaving(true);
    try {
      const { track, fileUri } = await saveTrimmedCopy(
        inspectTrack,
        inspectPoints,
        trimRange.start,
        trimRange.end,
      );
      addTrack(track, fileUri);
      showSnack(`Saved "${track.name}" to the library`);
      cancelTrim();
    } catch (err) {
      showSnack(`Trim failed: ${err instanceof Error ? err.message : 'could not save'}`);
    } finally {
      setTrimSaving(false);
    }
  }, [inspectTrack, inspectPoints, trimRange, addTrack, showSnack, cancelTrim]);

  const onOverwriteTrim = useCallback(async () => {
    if (!inspectTrack || !inspectPoints || !trimRange) return;
    setTrimSaving(true);
    try {
      const { patch } = await overwriteWithTrim(
        inspectTrack,
        inspectPoints,
        trimRange.start,
        trimRange.end,
      );
      updateTrack(inspectTrack.id, patch);
      showSnack(`Trimmed "${inspectTrack.name}"`);
      inspect(null); // points on disk changed — drop the stale inspection
    } catch (err) {
      showSnack(`Trim failed: ${err instanceof Error ? err.message : 'could not save'}`);
    } finally {
      setTrimSaving(false);
    }
    // `inspect` is a stable setter wrapper from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectTrack, inspectPoints, trimRange, updateTrack, showSnack]);

  // Tapping a live waypoint marker opens an editor for its note + photo.
  const [editWpId, setEditWpId] = useState<string | null>(null);
  const [wpDraft, setWpDraft] = useState('');
  const editWp = waypoints.find((w) => w.id === editWpId) ?? null;

  const openWaypoint = (id: string, note: string) => {
    setEditWpId(id);
    setWpDraft(note);
  };
  const saveWaypoint = () => {
    if (editWpId) updateWaypoint(editWpId, { note: wpDraft.trim() });
    setEditWpId(null);
  };

  // Waypoint tap handling. MapLibre's <Marker onPress> doesn't fire on Android,
  // so we hit-test the tap against the waypoint pins ourselves: the Map's onPress
  // gives the tap's pixel point; we project each waypoint to pixels (via the
  // cached bounds) and open the nearest one within tolerance. The pin is anchored
  // at its bottom tip, so its badge sits ~BADGE_OFFSET px above the coordinate.
  const WAYPOINT_BADGE_OFFSET = 45;
  const WAYPOINT_HIT_PX = 60;
  const onMapPress = useCallback(
    async (e: { nativeEvent?: { point?: [number, number] } }) => {
      const point = e.nativeEvent?.point;
      const map = mapRef.current;
      if (!point || !map || waypoints.length === 0) return;
      const [px, py] = point;
      let best: (typeof waypoints)[number] | null = null;
      let bestD = WAYPOINT_HIT_PX;
      try {
        // Project each pin through the real camera — a linear mapping over the
        // visible bounds is wrong the moment the map is rotated or pitched
        // (taps would miss, or open a different waypoint's note).
        const pts = await Promise.all(
          waypoints.map((wp) => map.project([wp.longitude, wp.latitude])),
        );
        for (let i = 0; i < waypoints.length; i++) {
          const p = pts[i];
          if (!p) continue;
          const d = Math.hypot(px - p[0], py - (p[1] - WAYPOINT_BADGE_OFFSET));
          if (d < bestD) {
            bestD = d;
            best = waypoints[i] ?? null;
          }
        }
      } catch {
        return; // projection unavailable mid-teardown — ignore the tap
      }
      if (best) openWaypoint(best.id, best.note ?? '');
    },
    [waypoints],
  );

  const trailFeature = useThrottledLineFeature(points);

  // Active saved-trail polylines (lng/lat) to drape on the 3D terrain.
  const trail3dLines = useMemo<readonly LngLat[][]>(
    () =>
      showTrackOverlays ? trackOverlays.map((t) => t.feature.geometry.coordinates as LngLat[]) : [],
    [showTrackOverlays, trackOverlays],
  );

  return (
    <View style={styles.fill}>
      {terrain3d ? (
        <Terrain3DLiveView
          center={location}
          basemap={basemap}
          permission={permission}
          trails={trail3dLines}
          recordPoints={points}
          waypoints={waypoints}
        />
      ) : (
        <Map
          ref={mapRef}
          style={styles.fill}
          mapStyle={style}
          attribution
          attributionPosition={{ bottom: 8, left: 8 }}
          // We draw our own compass badge (top-left), so hide MapLibre's native
          // compass — when the map is rotated it otherwise appears in the top-right,
          // peeking out behind our locate button as a stray dark circle.
          compass={false}
          touchPitch
          onPress={onMapPress}
          onRegionDidChange={() => void refreshBounds()}
          onLayout={onMapLayout}
        >
          <Camera
            ref={cameraRef}
            // Leaving 3D fully remounts <Map>/<Camera>; without a centre here
            // MapLibre defaults to [0,0] (null island, "middle of the Atlantic").
            // Seed it from the live location so we re-open on the user's position.
            initialViewState={{
              zoom: 14,
              ...(location
                ? { center: [location.longitude, location.latitude] as [number, number] }
                : {}),
            }}
            // "Rotate map with heading" setting: the map bearing always comes
            // from OUR filtered heading (see useHeadingCamera → useCompass),
            // whether or not we are following the user, eased over a short
            // linear transition so successive updates glide instead of ticking.
            // MapLibre normalizes bearing transitions to the shortest arc, so
            // 359°→1° turns 2°, not 358°. undefined when the setting is off.
            //
            // We deliberately do NOT use trackUserLocation="heading": that maps
            // to MapLibre's native CameraMode.TRACKING_COMPASS, which drives the
            // bearing from the platform's *raw* compass — the unfiltered signal
            // this whole module exists to tame, so the map would shake even
            // while the needle sat still. "default" (CameraMode.TRACKING) keeps
            // the centre-on-user behaviour and leaves the bearing to us.
            bearing={headingForCamera}
            {...(headingForCamera !== undefined
              ? { duration: 150, easing: 'linear' as const }
              : {})}
            trackUserLocation={followUser ? 'default' : undefined}
            onTrackUserLocationChange={(e) => {
              if (e.nativeEvent.trackUserLocation === null) setFollowUser(false);
            }}
            minZoom={1}
            // Camera cap; the raster SOURCES cap their tile-fetch zoom lower
            // (see NATIVE_MAX_ZOOM in mapStyle.ts) so zooming past each
            // service's real data — or past an offline pack's deepest stored
            // zoom — overscales the last real tiles (blurry) instead of
            // rendering Esri's "Map data not yet available" placeholders or
            // blank offline tiles.
            maxZoom={18}
          />

          {showPdfOverlay &&
            overlays.map((o) => (
              <ImageSource key={o.id} id={o.id} url={o.imageUri} coordinates={o.coordinates}>
                <Layer id={`${o.id}-layer`} type="raster" paint={{ 'raster-opacity': 0.92 }} />
              </ImageSource>
            ))}

          {showTrackOverlays &&
            trackOverlays.map((t) =>
              // While trimming, the inspected trail is drawn by the preview
              // sources below instead (kept segment bright, cut ends dimmed).
              trimPreview && t.id === inspectId ? null : (
                <GeoJSONSource
                  key={t.id}
                  id={`track-${t.id}`}
                  data={t.feature}
                  onPress={() => inspect(inspectId === t.id ? null : t.id)}
                >
                  <Layer
                    id={`track-${t.id}-line`}
                    type="line"
                    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                    paint={{
                      'line-color':
                        inspectId === t.id ? mapColors.trackOverlayActive : mapColors.trackOverlay,
                      'line-width': inspectId === t.id ? 6 : 4,
                      'line-opacity': 0.9,
                    }}
                  />
                </GeoJSONSource>
              ),
            )}

          {/* Trim preview: dimmed dashed cut ends under a bright kept segment. */}
          {trimPreview?.cutHead && (
            <GeoJSONSource id="trim-cut-head" data={trimPreview.cutHead}>
              <Layer
                id="trim-cut-head-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': mapColors.trimCut,
                  'line-width': 4,
                  'line-opacity': 0.6,
                  'line-dasharray': [1.5, 1.5],
                }}
              />
            </GeoJSONSource>
          )}
          {trimPreview?.cutTail && (
            <GeoJSONSource id="trim-cut-tail" data={trimPreview.cutTail}>
              <Layer
                id="trim-cut-tail-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': mapColors.trimCut,
                  'line-width': 4,
                  'line-opacity': 0.6,
                  'line-dasharray': [1.5, 1.5],
                }}
              />
            </GeoJSONSource>
          )}
          {trimPreview?.kept && (
            <GeoJSONSource id="trim-kept" data={trimPreview.kept}>
              <Layer
                id="trim-kept-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': mapColors.trimKept,
                  'line-width': 6,
                  'line-opacity': 0.95,
                }}
              />
            </GeoJSONSource>
          )}

          {markerAt && (
            <GeoJSONSource
              id="inspect-marker"
              data={{
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [markerAt.longitude, markerAt.latitude] },
                properties: {},
              }}
            >
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
            </GeoJSONSource>
          )}

          {trailFeature && (
            <GeoJSONSource id="trail" data={trailFeature}>
              <Layer
                id="trail-casing"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{ 'line-color': mapColors.trailCasing, 'line-width': 9 }}
              />
              <Layer
                id="trail-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{ 'line-color': mapColors.trail, 'line-width': 5 }}
              />
            </GeoJSONSource>
          )}

          {status !== 'idle' &&
            waypoints.map((w) => (
              // Visual only — tap handling is done at the map level (onMapPress);
              // MapLibre's <Marker onPress> doesn't fire on Android.
              <Marker key={w.id} id={w.id} lngLat={[w.longitude, w.latitude]} anchor="bottom">
                <WaypointMarkerPin hasPhoto={!!w.photoUri} />
              </Marker>
            ))}

          {/* Direction cone under the dot. The built-in `heading` arrow was
              dropped: it points along the GPS course (garbage while standing
              still); the cone tracks the smoothed compass instead. */}
          <HeadingCone location={location} />
          <UserLocation animated accuracy />
        </Map>
      )}

      {/* Region select overlay for offline download */}
      {selecting && !terrain3d && (
        <RegionSelectOverlay
          toGeo={toGeo}
          boundsVersion={boundsVersion}
          activeBasemap={basemap}
          tileUrl={tileUrl}
          onCancel={cancelRegionSelect}
          onConfirm={confirmDownload}
        />
      )}

      {/* Top-left compass. The badge subscribes to the compass itself so the
          rapid heading events re-render only the badge, not this whole tree. */}
      <View style={[styles.topLeft, { top: insets.top + 8 }]} pointerEvents="box-none">
        <CompassBadge onPress={resetNorth} />
      </View>

      {/* Right-side map controls */}
      <MapControlsRail
        top={insets.top + 8}
        onLocate={() => setFollowUser(true)}
        showFitControl={overlays.length > 0}
        onFit={fitActiveMap}
        terrain3d={terrain3d}
        onDownload={beginRegionSelect}
        downloadDisabled={downloadProgress !== null || status !== 'idle'}
        pdfOverlayCount={overlays.length}
        trackOverlayCount={trackOverlays.length}
      />

      {permission === 'denied' && (
        <Banner
          visible
          style={[styles.banner, { top: insets.top + 8 }]}
          icon="map-marker-off"
          actions={[]}
        >
          Location permission denied. Enable it in Settings to see your position and record trails.
        </Banner>
      )}

      {permission === 'granted' && unavailableReason !== null && (
        <Banner
          visible
          style={[styles.banner, { top: insets.top + 8 }]}
          icon="map-marker-off"
          actions={[]}
        >
          {unavailableReason}
        </Banner>
      )}

      {/* Bottom HUD + controls */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
        {/* Hide the recording UI while the region-select overlay is open so the
            Record button doesn't sit on top of the overlay's Confirm/Cancel bar. */}
        {!selecting && (
          <>
            {status !== 'idle' && (
              <StatsHud
                name={name}
                stats={stats}
                elapsedS={elapsedS}
                paused={status === 'paused'}
                gpsQuality={gpsQuality}
              />
            )}
            <View style={styles.controlsRow} pointerEvents="box-none">
              <RecordControls
                status={status}
                onPause={pause}
                onResume={resume}
                onStop={handleStop}
                onWaypoint={() => {
                  const n = addWaypoint();
                  if (n > 0) showSnack(`Waypoint ${n} dropped — tap it to add a note or photo`);
                  else showSnack('Waiting for a GPS fix before dropping a waypoint');
                }}
              />
            </View>
          </>
        )}
      </View>

      {inspectId && inspectPoints && inspectTrack && (
        <TrailInspectPanel
          track={inspectTrack}
          points={inspectPoints}
          onClose={() => inspect(null)}
          onScrub={setMarkerAt}
          trim={trimRange}
          onBeginTrim={beginTrim}
          onCancelTrim={cancelTrim}
          onChangeTrim={changeTrim}
          onSaveTrimCopy={() => void onSaveTrimCopy()}
          onOverwriteTrim={() => void onOverwriteTrim()}
          trimSaving={trimSaving}
        />
      )}

      {/* "+" speed-dial: the recording entry point (and home for future map
          actions). Hidden while a recording is under way (the active controls
          take over) and while selecting an offline region. */}
      {status === 'idle' && !selecting && <MapActionsFab onRecord={startRecording} />}

      <BackgroundLocationRationale visible={bgRationaleVisible} onRespond={respondToBgRationale} />

      <WaypointEditorDialog
        waypoint={editWp}
        draft={wpDraft}
        onChangeDraft={setWpDraft}
        onSave={saveWaypoint}
        onDelete={() => {
          if (editWpId) removeWaypoint(editWpId);
          setEditWpId(null);
        }}
        onSetPhoto={(uri) => {
          if (editWpId) updateWaypoint(editWpId, { photoUri: uri });
        }}
      />

      <Snackbar
        visible={snack !== null}
        onDismiss={dismissSnack}
        duration={Number.POSITIVE_INFINITY}
      >
        {snack ?? ''}
      </Snackbar>
      <Snackbar
        visible={overlaySnack !== null}
        onDismiss={dismissOverlaySnack}
        duration={Number.POSITIVE_INFINITY}
      >
        {overlaySnack ?? ''}
      </Snackbar>
      {downloadProgress !== null && (
        <Snackbar visible onDismiss={() => undefined} duration={Number.POSITIVE_INFINITY}>
          {`Downloading ${downloadProgress.label}… ${downloadProgress.pct}%`}
        </Snackbar>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  topLeft: { position: 'absolute', left: 12 },
  banner: { position: 'absolute', left: 8, right: 8, borderRadius: 12 },
  bottom: { position: 'absolute', left: 12, right: 12, bottom: 0, gap: 14 },
  controlsRow: { alignItems: 'center' },
});
