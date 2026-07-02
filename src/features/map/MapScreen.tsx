import { parseGpx } from '@core/geo/gpx';
import type { TrackPointAt } from '@core/geo/track';
import type { BoundingBox, LngLat, TrackPoint } from '@core/models';
import * as storage from '@data/storage';
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
import { type MapBasemap, useMapStore } from '@state/mapStore';
import { useRecorderStore } from '@state/recorderStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { setOfflineOnly } from '@data/offline';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import {
  Banner,
  Button,
  Dialog,
  Divider,
  FAB,
  Icon,
  IconButton,
  Menu,
  type MD3Theme,
  Portal,
  Snackbar,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RegionSelectOverlay } from './RegionSelectOverlay';
import { CompassBadge } from './components/CompassBadge';
import { ElevationProfile } from '../library/components/ElevationProfile';
import { RecordControls } from './components/RecordControls';
import { StatsHud } from './components/StatsHud';
import { WaypointMarkerPin } from './components/WaypointMarkerPin';
import { Terrain3DLiveView } from './Terrain3DLiveView';
import { toLineFeature, toLngLatBounds } from './geojson';
import { buildOsmStyle } from './mapStyle';
import { useCompass } from './useCompass';
import { useLocationTracking } from './useLocation';
import { usePdfOverlays } from './usePdfOverlay';
import { useTrackOverlays } from './useTrackOverlays';
import { useTimedSnackbar } from '../common/useTimedSnackbar';

/** Base-map choices shown in the layers menu, each with its own coloured icon. */
const BASEMAPS: {
  key: MapBasemap;
  label: string;
  icon: string;
  color: (t: MD3Theme) => string;
}[] = [
  { key: 'relief', label: 'Relief', icon: 'image-filter-hdr', color: () => '#9C6B3F' },
  { key: 'map', label: 'Map', icon: 'map', color: (t) => t.colors.primary },
  {
    key: 'satellite',
    label: 'Satellite',
    icon: 'satellite-variant',
    color: (t) => t.colors.tertiary,
  },
];

export function MapScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 });

  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const keepAwake = useSettingsStore((s) => s.keepAwakeWhileRecording);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const set = useSettingsStore((s) => s.set);

  const { permission, location } = useLocationTracking();
  const heading = useCompass();

  const maps = useLibraryStore((s) => s.maps);
  const tracks = useLibraryStore((s) => s.tracks);
  const { overlays, error: overlayError } = usePdfOverlays(maps);
  const trackOverlays = useTrackOverlays(tracks);

  const followUser = useMapStore((s) => s.followUser);
  const setFollowUser = useMapStore((s) => s.setFollowUser);
  const showPdfOverlay = useMapStore((s) => s.showPdfOverlay);
  const togglePdfOverlay = useMapStore((s) => s.togglePdfOverlay);
  const showTrackOverlays = useMapStore((s) => s.showTrackOverlays);
  const toggleTrackOverlays = useMapStore((s) => s.toggleTrackOverlays);
  const terrain3d = useMapStore((s) => s.terrain3d);
  const toggleTerrain3d = useMapStore((s) => s.toggleTerrain3d);
  const basemap = useMapStore((s) => s.basemap);
  const setBasemap = useMapStore((s) => s.setBasemap);
  // 2D base style with shaded-relief hillshade for the outdoor/topo look;
  // hillshade-3D was replaced by the real 3D terrain surface.
  const style = useMemo(() => buildOsmStyle(tileUrl, false, basemap, true), [tileUrl, basemap]);
  const focusBounds = useMapStore((s) => s.focusBounds);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const [overlayMenuOpen, setOverlayMenuOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  // The bottom-right "+" speed-dial (start recording today; room for more map
  // actions later — plan a route, drop a destination pin, import…).
  const [actionsOpen, setActionsOpen] = useState(false);
  const downloadProgress = useOfflineStore((s) => s.progress);

  // Consume a one-shot "fit these bounds" request (e.g. "view trail" from the
  // Library) — fly to the trail instead of staying on the user's location.
  useEffect(() => {
    if (!focusBounds) return;
    setFollowUser(false);
    cameraRef.current?.fitBounds(toLngLatBounds(focusBounds), {
      duration: 600,
      padding: { top: 60, right: 60, bottom: 220, left: 60 },
    });
    setFocusBounds(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBounds]);

  // Trail inspection: tap a trail trace to open its elevation profile; scrubbing
  // the profile drives a marker along the trace (markerAt).
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [inspectPoints, setInspectPoints] = useState<readonly TrackPoint[] | null>(null);
  const [markerAt, setMarkerAt] = useState<TrackPointAt | null>(null);
  const inspectTrack = tracks.find((t) => t.id === inspectId) ?? null;
  const inspectFileUri = inspectTrack?.fileUri ?? null;

  // Enter/leave inspection; clears any previously-loaded points + marker.
  const inspect = (id: string | null) => {
    setInspectId(id);
    setInspectPoints(null);
    setMarkerAt(null);
  };

  // Load the inspected trail's GPX points once selected.
  useEffect(() => {
    if (!inspectFileUri) return;
    let cancelled = false;
    (async () => {
      try {
        const gpx = await storage.readFileText(inspectFileUri);
        const { points: pts } = parseGpx(gpx);
        if (!cancelled) setInspectPoints(pts);
      } catch {
        if (!cancelled) setInspectPoints(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inspectFileUri]);

  const status = useRecorderStore((s) => s.status);
  const name = useRecorderStore((s) => s.name);
  const stats = useRecorderStore((s) => s.stats);
  const points = useRecorderStore((s) => s.points);
  const startedAt = useRecorderStore((s) => s.startedAt);
  const pausedMs = useRecorderStore((s) => s.pausedMs);
  const start = useRecorderStore((s) => s.start);
  const pause = useRecorderStore((s) => s.pause);
  const resume = useRecorderStore((s) => s.resume);
  const stop = useRecorderStore((s) => s.stop);
  const addWaypoint = useRecorderStore((s) => s.addWaypoint);
  const waypoints = useRecorderStore((s) => s.waypoints);
  const updateWaypoint = useRecorderStore((s) => s.updateWaypoint);
  const removeWaypoint = useRecorderStore((s) => s.removeWaypoint);

  const [elapsedS, setElapsedS] = useState(0);
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
  const pickWaypointPhoto = async (fromCamera: boolean) => {
    if (!editWpId) return;
    if (fromCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
    }
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
    const picked = res.canceled ? null : res.assets[0]?.uri;
    if (!picked) return;
    const stored = await storage.importPhoto(picked, storage.newId());
    updateWaypoint(editWpId, { photoUri: stored });
  };

  // Live elapsed timer, independent of GPS fix cadence. Excludes paused wall
  // time (pausedMs) so resuming continues from where the display froze instead
  // of jumping forward by the whole pause.
  useEffect(() => {
    if (status !== 'recording' || startedAt === null) return;
    const tick = () => setElapsedS(Math.floor((Date.now() - startedAt - pausedMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status, startedAt, pausedMs]);

  // Keep the screen on while actively recording (if enabled).
  useEffect(() => {
    if (status === 'recording' && keepAwake) {
      void activateKeepAwakeAsync('inukshuk-recording');
      return () => {
        void deactivateKeepAwake('inukshuk-recording');
      };
    }
    return undefined;
  }, [status, keepAwake]);

  // Convert a screen point (px) to [lng, lat] using the current map bounds.
  // Cache of the map's visible bounds [west, south, east, north]. Kept fresh by
  // onRegionDidChange and seeded when the download overlay opens, so the
  // screen→geo conversion below is SYNCHRONOUS — letting the region-select
  // estimate update live as the box is reshaped (getBounds() is async, which
  // forced a debounce that only landed the estimate after the drag released).
  const boundsRef = useRef<[number, number, number, number] | null>(null);
  const refreshBounds = useCallback(async () => {
    const b = await mapRef.current?.getBounds();
    if (b) boundsRef.current = b as [number, number, number, number];
  }, []);

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

  // Screen point (px) → [lng, lat], synchronously, from the cached bounds.
  const toGeo = useCallback(
    ({ x, y }: { x: number; y: number }): [number, number] | null => {
      const b = boundsRef.current;
      if (!b || mapSize.w === 0 || mapSize.h === 0) return null;
      const [w, s, e, n] = b;
      const fx = Math.max(0, Math.min(1, x / mapSize.w));
      const fy = Math.max(0, Math.min(1, y / mapSize.h));
      return [w + fx * (e - w), n - fy * (n - s)]; // north at top; linear approx
    },
    [mapSize],
  );

  // Apply the persisted offlineOnly flag once settings hydrate. Child effects
  // run before RootLayout's, so a mount-only effect always saw the default
  // (false) and a persisted "Locally downloaded only" was silently ignored
  // until manually re-toggled. Re-runs on later changes to stay in sync.
  useEffect(() => {
    if (settingsHydrated) setOfflineOnly(offlineOnly);
  }, [settingsHydrated, offlineOnly]);
  // Hydrate offline tile regions on mount.
  useEffect(() => {
    void useOfflineStore.getState().hydrate();
  }, []);

  const trailFeature = useMemo(() => toLineFeature(points), [points]);

  // Active saved-trail polylines (lng/lat) to drape on the 3D terrain.
  const trail3dLines = useMemo<readonly LngLat[][]>(
    () =>
      showTrackOverlays ? trackOverlays.map((t) => t.feature.geometry.coordinates as LngLat[]) : [],
    [showTrackOverlays, trackOverlays],
  );

  // Union bounds of all active overlays, for the "fit to page" control.
  const overlaysBbox = useMemo<BoundingBox | null>(() => {
    if (overlays.length === 0) return null;
    return overlays.reduce<BoundingBox | null>(
      (acc, o) =>
        acc === null
          ? o.bbox
          : {
              minLat: Math.min(acc.minLat, o.bbox.minLat),
              minLng: Math.min(acc.minLng, o.bbox.minLng),
              maxLat: Math.max(acc.maxLat, o.bbox.maxLat),
              maxLng: Math.max(acc.maxLng, o.bbox.maxLng),
            },
      null,
    );
  }, [overlays]);

  const fitActiveMap = () => {
    if (overlaysBbox) {
      setFollowUser(false);
      cameraRef.current?.fitBounds(toLngLatBounds(overlaysBbox), {
        duration: 600,
        padding: { top: 48, right: 48, bottom: 48, left: 48 },
      });
    }
  };

  // Tapping the compass snaps the map back to north (bearing 0), keeping the
  // current center and zoom.
  const resetNorth = () => {
    cameraRef.current?.setStop({ bearing: 0, duration: 300 });
  };

  // Recording and 3D don't mix (3D can crash mid-record), so drop out of 3D when
  // a recording starts — the 3D button is disabled for the duration anyway.
  const startRecording = () => {
    setActionsOpen(false);
    if (terrain3d) toggleTerrain3d();
    start();
  };

  const handleStop = async () => {
    const track = await stop();
    setElapsedS(0);
    showSnack(
      track && track.points.length > 0
        ? `Saved "${track.name}"`
        : 'Recording discarded (no points)',
    );
  };

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
          onLayout={(e) =>
            setMapSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
          }
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
            trackUserLocation={followUser ? 'default' : undefined}
            onTrackUserLocationChange={(e) => {
              if (e.nativeEvent.trackUserLocation === null) setFollowUser(false);
            }}
            minZoom={1}
            // Cap at 18: the raster basemaps (OSM z19, Esri) have real tiles to
            // here globally. Past this, sparse high-zoom tiles run out and MapLibre
            // shows "Map data not yet available" / blank — so don't let the user
            // zoom into that dead zone.
            maxZoom={18}
          />

          {showPdfOverlay &&
            overlays.map((o) => (
              <ImageSource key={o.id} id={o.id} url={o.imageUri} coordinates={o.coordinates}>
                <Layer id={`${o.id}-layer`} type="raster" paint={{ 'raster-opacity': 0.92 }} />
              </ImageSource>
            ))}

          {showTrackOverlays &&
            trackOverlays.map((t) => (
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
            ))}

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

          <UserLocation animated accuracy heading />
        </Map>
      )}

      {/* Region select overlay for offline download */}
      {selecting && !terrain3d && (
        <RegionSelectOverlay
          toGeo={toGeo}
          activeBasemap={basemap}
          tileUrl={tileUrl}
          onCancel={() => setSelecting(false)}
          onConfirm={(bounds, basemaps, minZoom, maxZoom) => {
            setSelecting(false);
            void (async () => {
              try {
                await useOfflineStore.getState().downloadMany({
                  baseId: storage.newId(),
                  label: 'Offline map',
                  bounds,
                  minZoom,
                  maxZoom,
                  layers: basemaps.map((bm) => ({
                    basemap: bm,
                    styleJSON: JSON.stringify(buildOsmStyle(tileUrl, false, bm)),
                  })),
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                showSnack('Download failed: ' + message);
              }
            })();
          }}
        />
      )}

      {/* Top-left compass */}
      <View style={[styles.topLeft, { top: insets.top + 8 }]} pointerEvents="box-none">
        <CompassBadge heading={heading} onPress={resetNorth} />
      </View>

      {/* Right-side map controls */}
      <View style={[styles.rightControls, { top: insets.top + 8 }]} pointerEvents="box-none">
        <FAB
          icon="crosshairs-gps"
          size="small"
          variant="surface"
          onPress={() => setFollowUser(true)}
          style={styles.controlFab}
        />
        {overlays.length > 0 && (
          <FAB
            icon="fit-to-page-outline"
            size="small"
            variant="surface"
            onPress={fitActiveMap}
            style={styles.controlFab}
          />
        )}
        {/* 3D relief temporarily pulled back — the live-3D experience isn't where
            we want it yet. The Terrain3DLiveView code stays in the tree (gated off
            via the `terrain3d` store flag, which nothing toggles now) so it's ready
            to re-enable once the camera/gesture feel is dialed in. */}
        {!terrain3d && (
          <FAB
            icon="tray-arrow-down"
            size="small"
            variant="surface"
            onPress={() => {
              // "Locally downloaded only" cuts MapLibre's network process-wide, which
              // would stall a download (it can't fetch tiles). Rather than fight that
              // at runtime, require the user to turn it off first.
              if (offlineOnly) {
                showSnack("Turn off 'Locally downloaded only' to download a new area");
                return;
              }
              // The region box uses a linear screen→geo projection that is only
              // valid for a north-up, unpitched 2D map, so flatten the camera first.
              cameraRef.current?.setStop({ bearing: 0, pitch: 0, duration: 300 });
              void refreshBounds(); // seed the bounds cache so the estimate is ready
              setSelecting(true);
            }}
            // Block re-entry while a download is running (a second download would
            // stop the first's loopback server mid-flight), and while recording.
            disabled={downloadProgress !== null || status !== 'idle'}
            style={styles.controlFab}
            accessibilityLabel="Download offline area"
          />
        )}
        <Menu
          visible={overlayMenuOpen}
          onDismiss={() => setOverlayMenuOpen(false)}
          anchor={
            <FAB
              icon="layers"
              size="small"
              variant="surface"
              onPress={() => setOverlayMenuOpen(true)}
              style={styles.controlFab}
              accessibilityLabel="Layers"
            />
          }
        >
          <Menu.Item disabled title="Overlays" />
          <Menu.Item
            leadingIcon={showPdfOverlay ? 'checkbox-marked' : 'checkbox-blank-outline'}
            onPress={overlays.length > 0 ? togglePdfOverlay : undefined}
            disabled={overlays.length === 0}
            title={`PDF (${overlays.length})`}
          />
          <Menu.Item
            leadingIcon={showTrackOverlays ? 'checkbox-marked' : 'checkbox-blank-outline'}
            onPress={trackOverlays.length > 0 ? toggleTrackOverlays : undefined}
            disabled={trackOverlays.length === 0}
            title={`Trails (${trackOverlays.length})`}
          />
          <Divider />
          <Menu.Item
            leadingIcon={offlineOnly ? 'checkbox-marked' : 'checkbox-blank-outline'}
            onPress={() => {
              const next = !offlineOnly;
              set('offlineOnly', next);
              setOfflineOnly(next);
            }}
            title="Locally downloaded only"
          />
          <Divider />
          <Menu.Item disabled title="Base map" />
          {BASEMAPS.map((b) => (
            <Menu.Item
              key={b.key}
              leadingIcon={({ size }) => (
                <Icon source={b.icon} size={size} color={b.color(theme)} />
              )}
              trailingIcon={basemap === b.key ? 'check' : undefined}
              onPress={() => {
                setBasemap(b.key);
                setOverlayMenuOpen(false);
              }}
              title={b.label}
            />
          ))}
        </Menu>
      </View>

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
        <Surface style={[styles.inspectPanel, { paddingBottom: insets.bottom + 8 }]} elevation={4}>
          <View style={styles.inspectHeader}>
            <Text variant="titleSmall" numberOfLines={1} style={styles.inspectTitle}>
              {inspectTrack.name}
            </Text>
            <IconButton
              icon="close"
              size={20}
              onPress={() => inspect(null)}
              accessibilityLabel="Close trail inspector"
            />
          </View>
          <ElevationProfile
            points={inspectPoints}
            ascentM={inspectTrack.stats.ascentM}
            descentM={inspectTrack.stats.descentM}
            onScrub={setMarkerAt}
          />
        </Surface>
      )}

      {/* "+" speed-dial: the recording entry point (and home for future map
          actions). Hidden while a recording is under way (the active controls
          take over) and while selecting an offline region. */}
      {status === 'idle' && !selecting && (
        <FAB.Group
          open={actionsOpen}
          visible
          icon={actionsOpen ? 'close' : 'plus'}
          color={theme.colors.onTertiary}
          fabStyle={{ backgroundColor: theme.colors.tertiary }}
          backdropColor="#00000066"
          actions={[
            {
              icon: 'record-circle',
              label: 'Record track',
              onPress: startRecording,
            },
          ]}
          onStateChange={({ open }) => setActionsOpen(open)}
          accessibilityLabel="Map actions"
        />
      )}

      <Portal>
        <Dialog visible={editWp !== null} onDismiss={saveWaypoint}>
          <Dialog.Title>{editWp?.label ?? 'Waypoint'}</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Note"
              value={wpDraft}
              onChangeText={setWpDraft}
              autoFocus
              multiline
              mode="outlined"
              placeholder="What's here?"
            />
            {editWp?.photoUri ? (
              <View style={styles.wpPhotoWrap}>
                <Image source={{ uri: editWp.photoUri }} style={styles.wpPhoto} />
                <Button
                  compact
                  icon="image-remove"
                  onPress={() => editWpId && updateWaypoint(editWpId, { photoUri: '' })}
                >
                  Remove photo
                </Button>
              </View>
            ) : (
              <View style={styles.wpPhotoButtons}>
                <Button compact icon="image-outline" onPress={() => pickWaypointPhoto(false)}>
                  Photo
                </Button>
                <Button compact icon="camera-outline" onPress={() => pickWaypointPhoto(true)}>
                  Camera
                </Button>
              </View>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button
              textColor={theme.colors.error}
              onPress={() => {
                if (editWpId) removeWaypoint(editWpId);
                setEditWpId(null);
              }}
            >
              Delete
            </Button>
            <View style={styles.fill} />
            <Button onPress={saveWaypoint}>Done</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

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
  rightControls: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  controlFab: { borderRadius: 24 },
  banner: { position: 'absolute', left: 8, right: 8, borderRadius: 12 },
  bottom: { position: 'absolute', left: 12, right: 12, bottom: 0, gap: 14 },
  controlsRow: { alignItems: 'center' },
  inspectPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 4,
  },
  inspectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
  },
  inspectTitle: { flexShrink: 1, fontWeight: '700' },
  wpPhotoWrap: { marginTop: 12, alignItems: 'flex-start', gap: 6 },
  wpPhoto: { width: '100%', height: 180, borderRadius: 10 },
  wpPhotoButtons: { marginTop: 12, flexDirection: 'row', gap: 8 },
});
