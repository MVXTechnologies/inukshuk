import { buildDownloadedMask } from '@core/geo/downloadedMask';
import { visibleMaps, visibleTrackIds, visibleWaypoints } from '@core/library/visibility';
import { resolveInitialCenter } from '@core/geo/lastKnownPosition';
import { offlinePackMaxZoom } from '@core/geo/tiles';
import type { BoundingBox, LngLat, TrackPoint } from '@core/models';
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
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Banner, Snackbar, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RegionSelectOverlay } from './RegionSelectOverlay';
import { MakeMapSheet, type MakeMapProgress } from './mapmaker/MakeMapSheet';
import { makeMap } from './mapmaker/makeMap';
import type { ComposeHandle, MakeMapOptions } from './mapmaker/composeMapPdf';
import { BackgroundLocationRationale } from './components/BackgroundLocationRationale';
import { CategoryStartSheet } from './components/CategoryStartSheet';
import { CompassBadge } from './components/CompassBadge';
import { HeadingCone } from './components/HeadingCone';
import { MapActionsFab } from './components/MapActionsFab';
import { MapControlsRail } from './components/MapControlsRail';
import { RecordControls } from './components/RecordControls';
import { StatsHud } from './components/StatsHud';
import { TrailInspectPanel } from './components/TrailInspectPanel';
import { WaypointEditorDialog } from './components/WaypointEditorDialog';
import { WaypointMarkerPin } from './components/WaypointMarkerPin';
import { WaypointViewerCard } from './components/WaypointViewerCard';
import { formatLatLng } from '@core/geo/formatCoords';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
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
import { useTerrainOverlays2D } from './useTerrainOverlays2D';
import { useTrackHeat } from './useTrackHeat';
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
  // True only between onDidFinishLoadingMap and the next onWillStartLoadingMap
  // (which also fires when a remounted <Map> — e.g. back from 3D — starts
  // loading, re-arming the gate). Every mapRef.getViewState() must be gated on
  // this: called before the native view is initialized, MLRNMapView.getCenter
  // NPEs on the native thread — a process crash a JS .catch() cannot intercept
  // (the launch-race crash behind the 07-30 nightly and local blank screens).
  const [mapLoaded, setMapLoaded] = useState(false);

  const tileUrl = useSettingsStore((s) => s.tileUrl);
  // Cold-start camera seed: the persisted last known map position. Hydration is
  // async, so the map mount is gated on `hydrated` below — mounting earlier
  // would read the default null and seed the camera with nothing.
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const lastKnownPosition = useSettingsStore((s) => s.lastKnownPosition);

  const { permission, location, unavailableReason } = useLocationTracking();
  const headingForCamera = useHeadingCamera();

  const maps = useLibraryStore((s) => s.maps);
  const tracks = useLibraryStore((s) => s.tracks);
  const addTrack = useLibraryStore((s) => s.addTrack);
  const updateTrack = useLibraryStore((s) => s.updateTrack);
  // Standalone waypoints (dropped from the "+" speed-dial, no recording needed).
  const savedWaypoints = useLibraryStore((s) => s.waypoints);
  const addSavedWaypoint = useLibraryStore((s) => s.addWaypoint);
  const updateSavedWaypoint = useLibraryStore((s) => s.updateWaypoint);
  const removeSavedWaypoint = useLibraryStore((s) => s.removeWaypoint);
  // Map-visibility modes: 'type' = the classic PDF/Trails switches; 'folders'
  // = exactly the checked folders' maps, trails and waypoints (pure selectors
  // in @core/library/visibility).
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const activeTrackIds = useLibraryStore((s) => s.activeTrackIds);
  const shownMaps = useMemo(
    () => visibleMaps(mapVisibilityMode, visibleFolderIds, maps),
    [mapVisibilityMode, visibleFolderIds, maps],
  );
  const shownTrackIds = useMemo(
    () => visibleTrackIds(mapVisibilityMode, visibleFolderIds, tracks, activeTrackIds),
    [mapVisibilityMode, visibleFolderIds, tracks, activeTrackIds],
  );
  const { overlays, error: overlayError } = usePdfOverlays(shownMaps);
  // useTrackOverlays still backs the 3D drape (trail3dLines below) and the
  // controls-rail overlay count — only the 2D per-trail render block was
  // replaced by the combined heat source (trackHeat), so this call stays.
  const trackOverlays = useTrackOverlays(tracks, shownTrackIds);
  const trackHeat = useTrackHeat(tracks, shownTrackIds);
  // Tap-selected heat spot (set by Task 9's onMapPress routing); staying null
  // here just picks focusedTrackId back to the inspected trail.
  const [heatSelection] = useState<{
    lngLat: { lng: number; lat: number };
    trackIds: string[];
    focusedIdx: number;
  } | null>(null);

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
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  // 'minimal' style: chevron-rail unfold state lives here because the "+"
  // dial hides with the rest of the controls until the rail is out.
  const [minimalControlsOpen, setMinimalControlsOpen] = useState(false);
  const markedTrailsNetworks = useSettingsStore((s) => s.markedTrailsNetworks);
  const style = useMemo(() => {
    const options = {
      // The 'edge' UI style washes the raster into pastels to match its chrome.
      pastel: uiStyle === 'edge',
      // Marked-trail networks (network-only; hidden while offline-only).
      markedTrailsNetworks: offlineOnly ? [] : markedTrailsNetworks,
      ...(offlineOnly
        ? {
            rasterMaxZoom: offlinePackMaxZoom(offlineRegions, basemap),
            downloadedMask: {
              data: buildDownloadedMask(
                offlineRegions.filter((r) => r.basemap === basemap).map((r) => r.bounds),
              ),
              color: theme.dark ? theme.colors.background : '#FFFFFF',
            },
          }
        : {}),
    };
    return buildOsmStyle(tileUrl, false, basemap, true, options);
  }, [
    tileUrl,
    basemap,
    offlineOnly,
    offlineRegions,
    theme.dark,
    theme.colors.background,
    uiStyle,
    markedTrailsNetworks,
  ]);

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
    prepareRegionGeometry,
    resolveRegionRect,
  } = useOfflineDownload({ mapRef, cameraRef, showSnack, mapLoaded });

  const { fitOverlayBounds, resetNorth, zoomToLocateLevel } = useCameraControls({
    cameraRef,
    mapRef,
    overlays,
  });
  // Rotation index for the fit FAB's PDF tour (reset when the set changes).
  const fitCycleRef = useRef(0);
  useEffect(() => {
    fitCycleRef.current = 0;
  }, [overlays.length]);

  // 2D slope/contour overlays, recomputed as the camera settles on new bounds.
  // Driven by its own counter bumped on EVERY region change — refreshBounds's
  // boundsVersion only advances for a flat north-up camera (its offline-select
  // contract), which froze the overlays on a rotated/pitched map: pan all you
  // want, nothing recomputed until the layer was toggled off and on.
  // In 3D the terrain shader draws the same analysis from the same settings.
  const [regionVersion, setRegionVersion] = useState(0);
  // Tab screens stay mounted, so without a focus gate the overlay pipeline
  // kept fetching DEM tiles and contouring in the background after switching
  // to Library/Settings.
  const [screenFocused, setScreenFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      return () => setScreenFocused(false);
    }, []),
  );
  const terrainOverlays2d = useTerrainOverlays2D({
    mapRef,
    boundsVersion: regionVersion,
    // offlineOnly also disables these: DEM-derived layers drape over the
    // downloaded-only mask's blank void, which reads as garbage.
    // mapLoaded: the pipeline opens with getViewState — see the state's
    // declaration comment (native crash if called before the map loads).
    active: !terrain3d && settingsHydrated && screenFocused && !offlineOnly && mapLoaded,
  });
  useEffect(() => {
    if (terrainOverlays2d.error) showOverlaySnack(`Terrain overlay: ${terrainOverlays2d.error}`);
  }, [terrainOverlays2d.error, showOverlaySnack]);

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

  // Library → "Trim": a one-shot store intent opens the trail in the inspect
  // panel and, once its points load, enters trim mode. Consumed here because
  // the inspection state is local to this screen. The pending trim is keyed by
  // track id so an inspection switched mid-load never trims the wrong trail.
  const inspectIntent = useMapStore((s) => s.inspectIntent);
  const setInspectIntent = useMapStore((s) => s.setInspectIntent);
  const pendingTrimId = useRef<string | null>(null);
  useEffect(() => {
    if (!inspectIntent) return;
    pendingTrimId.current = inspectIntent.trim ? inspectIntent.trackId : null;
    inspect(inspectIntent.trackId);
    setInspectIntent(null);
    // `inspect` is a stable setter wrapper from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectIntent, setInspectIntent]);
  useEffect(() => {
    if (!inspectPoints || inspectId === null || inspectId !== pendingTrimId.current) return;
    pendingTrimId.current = null;
    if (inspectPoints.length >= 3) beginTrim();
    else showSnack('This trail is too short to trim');
  }, [inspectPoints, inspectId, beginTrim, showSnack]);

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

  // "Record track" intercepts here: the category sheet opens first, and only
  // its Start button actually begins the recording (owner ask: pick an
  // activity category BEFORE recording starts).
  const [pickingCategory, setPickingCategory] = useState(false);

  // --- Map maker (1.4.0): region box → options sheet → compose → Library ---
  const [makeMapState, setMakeMapState] = useState<
    | null
    | { phase: 'select' }
    | { phase: 'options'; bbox: BoundingBox }
    | { phase: 'generating'; bbox: BoundingBox; progress: MakeMapProgress }
  >(null);
  const makeMapHandleRef = useRef<ComposeHandle>({ aborted: false });
  const startMakeMap = useCallback(
    (bbox: BoundingBox, options: MakeMapOptions) => {
      const handle: ComposeHandle = { aborted: false };
      makeMapHandleRef.current = handle;
      setMakeMapState({ phase: 'generating', bbox, progress: { phase: 'tiles', frac: 0 } });
      void makeMap(
        bbox,
        options,
        (phase, frac) => {
          if (!handle.aborted)
            setMakeMapState((s) =>
              s?.phase === 'generating' ? { ...s, progress: { phase, frac } } : s,
            );
        },
        handle,
      )
        .then((doc) => {
          setMakeMapState(null);
          showSnack(`"${doc.name}" saved to the library`);
        })
        .catch((err: unknown) => {
          if (handle.aborted) return;
          setMakeMapState({ phase: 'options', bbox });
          const message = err instanceof Error ? err.message : 'unknown error';
          showSnack(`Couldn't make the map: ${message}`);
        });
    },
    [showSnack],
  );

  // Tapping a live waypoint marker opens an editor for its note + photo.
  // Tapping a waypoint marker — a live recording pin or a saved standalone pin
  // — opens the shared editor for its note + photo. The edit target is tagged
  // with its source store so save/delete/photo dispatch to the right one.
  const [editWp, setEditWp] = useState<{ source: 'live' | 'saved'; id: string } | null>(null);
  const [wpDraft, setWpDraft] = useState('');
  // Read-only viewer target (pin tap). Editing is an explicit step from it.
  const [viewWp, setViewWp] = useState<{ source: 'live' | 'saved'; id: string } | null>(null);
  const findWp = useCallback(
    (ref: { source: 'live' | 'saved'; id: string } | null) =>
      ref === null
        ? null
        : ref.source === 'live'
          ? (waypoints.find((w) => w.id === ref.id) ?? null)
          : (savedWaypoints.find((w) => w.id === ref.id) ?? null),
    [waypoints, savedWaypoints],
  );
  const editWaypoint = findWp(editWp);
  const viewWaypoint = findWp(viewWp);

  const saveWaypoint = () => {
    if (editWp) {
      const patch = { note: wpDraft.trim() };
      if (editWp.source === 'live') updateWaypoint(editWp.id, patch);
      else updateSavedWaypoint(editWp.id, patch);
    }
    setEditWp(null);
  };
  const deleteWaypoint = () => {
    if (editWp) {
      if (editWp.source === 'live') removeWaypoint(editWp.id);
      else removeSavedWaypoint(editWp.id);
    }
    setEditWp(null);
  };
  const setWaypointPhoto = (uri: string) => {
    if (!editWp) return;
    if (editWp.source === 'live') updateWaypoint(editWp.id, { photoUri: uri });
    else updateSavedWaypoint(editWp.id, { photoUri: uri });
  };

  // "+" speed-dial → Add waypoint: drop a standalone waypoint at the current
  // GPS position and open the editor on it right away.
  const onAddWaypoint = useCallback(() => {
    if (!location) {
      showSnack('Waiting for a GPS fix before dropping a waypoint');
      return;
    }
    const id = addSavedWaypoint(location.latitude, location.longitude);
    setEditWp({ source: 'saved', id });
    setWpDraft('');
  }, [location, addSavedWaypoint, showSnack]);

  // Every waypoint pin currently drawn on the 2D map (live pins only exist
  // while a recording session is up), tagged with its source for tap handling.
  // Saved pins respect the folder-visibility mode; live pins always draw.
  const visiblePins = useMemo(
    () => [
      ...visibleWaypoints(mapVisibilityMode, visibleFolderIds, savedWaypoints).map((w) => ({
        source: 'saved' as const,
        ...w,
      })),
      ...(status !== 'idle' ? waypoints.map((w) => ({ source: 'live' as const, ...w })) : []),
    ],
    [savedWaypoints, waypoints, status, mapVisibilityMode, visibleFolderIds],
  );

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
      if (!point || !map || visiblePins.length === 0) return;
      const [px, py] = point;
      let best: (typeof visiblePins)[number] | null = null;
      let bestD = WAYPOINT_HIT_PX;
      try {
        // Project each pin through the real camera — a linear mapping over the
        // visible bounds is wrong the moment the map is rotated or pitched
        // (taps would miss, or open a different waypoint's note).
        const pts = await Promise.all(
          visiblePins.map((wp) => map.project([wp.longitude, wp.latitude])),
        );
        for (let i = 0; i < visiblePins.length; i++) {
          const p = pts[i];
          if (!p) continue;
          const d = Math.hypot(px - p[0], py - (p[1] - WAYPOINT_BADGE_OFFSET));
          if (d < bestD) {
            bestD = d;
            best = visiblePins[i] ?? null;
          }
        }
      } catch {
        return; // projection unavailable mid-teardown — ignore the tap
      }
      if (best) {
        // Pin tap opens the read-only viewer; a second tap on the same pin
        // (or the card's ✕) closes it. Editing is the card's explicit step.
        setViewWp((cur) =>
          cur?.id === best.id && cur.source === best.source
            ? null
            : { source: best.source, id: best.id },
        );
      } else {
        setViewWp(null); // tapping empty map dismisses the viewer
      }
    },
    [visiblePins],
  );

  const trailFeature = useThrottledLineFeature(points);

  // Camera seed: live fix → persisted last known position → MapLibre default.
  // `location` covers the 3D→2D remount (the live fix is already in hand);
  // `lastKnownPosition` covers the cold start, where the first fix may be
  // minutes away (indoors) — without it the map opened on [0,0], null island.
  const initialCenter = resolveInitialCenter(location, lastKnownPosition);

  // Active saved-trail polylines (lng/lat) to drape on the 3D terrain.
  const trail3dLines = useMemo<readonly LngLat[][]>(
    () =>
      showTrackOverlays ? trackOverlays.map((t) => t.feature.geometry.coordinates as LngLat[]) : [],
    [showTrackOverlays, trackOverlays],
  );

  // Which trail the heat layers highlight: a tap-selected trail (Task 9) wins,
  // otherwise fall back to whichever trail is open in the inspect panel.
  // dimOthers only kicks in once a heat selection exists (a spot with more
  // than one trail underneath it) — plain inspection doesn't dim the rest.
  const focusedTrackId = heatSelection
    ? (heatSelection.trackIds[heatSelection.focusedIdx] ?? null)
    : inspectId;
  const dimOthers = heatSelection !== null;

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
      ) : !settingsHydrated ? null : ( // wait for the persisted camera seed (a few ms at launch)
        <Map
          ref={mapRef}
          style={styles.fill}
          mapStyle={style}
          attribution
          // MapLibre's wordmark logo also defaults to the bottom-left corner,
          // exactly where the attribution "i" used to sit — the two ornaments
          // rendered on top of each other. Stack the attribution button above
          // the logo instead; both must stay visible (OSM/Esri attribution is
          // a license requirement, and hiding the logo isn't wanted either).
          attributionPosition={{ bottom: 48, left: 8 }}
          logo
          logoPosition={{ bottom: 8, left: 8 }}
          // We draw our own compass badge (top-left), so hide MapLibre's native
          // compass — when the map is rotated it otherwise appears in the top-right,
          // peeking out behind our locate button as a stray dark circle.
          compass={false}
          touchPitch
          onPress={onMapPress}
          onWillStartLoadingMap={() => setMapLoaded(false)}
          onDidFinishLoadingMap={() => setMapLoaded(true)}
          onRegionDidChange={() => {
            setRegionVersion((v) => v + 1);
            void refreshBounds();
          }}
          onLayout={onMapLayout}
        >
          <Camera
            ref={cameraRef}
            // Cold launch and leaving 3D both mount <Map>/<Camera> fresh;
            // without a centre here MapLibre defaults to [0,0] (null island,
            // "middle of the Atlantic"). Seed from the live location when we
            // have one, else the persisted last known position. Once the first
            // fix lands, follow mode (trackUserLocation below, on by default)
            // flies the camera to it natively — no manual fly needed, and none
            // wanted if the user already panned away (which clears followUser).
            initialViewState={{
              zoom: 14,
              ...(initialCenter ? { center: initialCenter } : {}),
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

          {/* Terrain overlays sit above the (near-opaque) PDF maps — they're
              explicit user toggles — and below trails/markers. The slope
              raster keeps NEAREST resampling so band edges stay hard when the
              256-cell grid is stretched over the viewport (the CalTopo look);
              opacity matches the 3D shader's SLOPE_OPACITY. */}
          {terrainOverlays2d.slope && (
            <ImageSource
              id="slope2d"
              url={terrainOverlays2d.slope.uri}
              coordinates={terrainOverlays2d.slope.coordinates}
            >
              <Layer
                id="slope2d-layer"
                type="raster"
                paint={{ 'raster-opacity': 0.62, 'raster-resampling': 'nearest' }}
              />
            </ImageSource>
          )}
          {/* Contours must contrast with the ground: white over satellite
              imagery (mostly dark), the warm brown over the light map/relief
              basemaps — each with a thin opposite-shade halo so lines stay
              readable across mixed terrain (line layers can't sample the
              raster beneath, so this is per-basemap, not per-pixel; the 3D
              shader does the true per-pixel version). */}
          {terrainOverlays2d.contours && (
            <GeoJSONSource id="contours2d-minor" data={terrainOverlays2d.contours.minor}>
              <Layer
                id="contours2d-minor-halo"
                type="line"
                paint={{
                  'line-color': basemap === 'satellite' ? '#000000' : '#FFFFFF',
                  'line-opacity': 0.35,
                  'line-width': 2.2,
                }}
              />
              <Layer
                id="contours2d-minor-line"
                type="line"
                paint={{
                  'line-color': basemap === 'satellite' ? '#FFFFFF' : '#4a3b2a',
                  'line-opacity': basemap === 'satellite' ? 0.8 : 0.5,
                  'line-width': 1,
                }}
              />
            </GeoJSONSource>
          )}
          {terrainOverlays2d.contours && (
            <GeoJSONSource id="contours2d-major" data={terrainOverlays2d.contours.major}>
              <Layer
                id="contours2d-major-halo"
                type="line"
                paint={{
                  'line-color': basemap === 'satellite' ? '#000000' : '#FFFFFF',
                  'line-opacity': 0.45,
                  'line-width': 3.2,
                }}
              />
              <Layer
                id="contours2d-major-line"
                type="line"
                paint={{
                  'line-color': basemap === 'satellite' ? '#FFFFFF' : '#4a3b2a',
                  'line-opacity': basemap === 'satellite' ? 0.95 : 0.75,
                  'line-width': 1.8,
                }}
              />
            </GeoJSONSource>
          )}

          {/* Combined heat source: every shown trail's GPX in one
              FeatureCollection, colour-coded per category with hot/cold runs
              (see useTrackHeat). Layer order matters — glow under trace under
              the focused-trail highlight. Tap routing lands in Task 9; the
              per-trail onPress this replaced is gone until then. */}
          {showTrackOverlays && trackHeat.collection && (
            <GeoJSONSource id="tracks-heat" data={trackHeat.collection}>
              <Layer
                id="tracks-heat-glow"
                type="line"
                filter={['==', ['get', 'hot'], true]}
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': ['get', 'color'],
                  'line-width': ['step', ['get', 'count'], 10, 3, 13, 5, 16],
                  'line-blur': 6,
                  'line-opacity': 0.35,
                }}
              />
              <Layer
                id="tracks-heat-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': ['get', 'color'],
                  'line-width': [
                    'case',
                    ['==', ['get', 'hot'], true],
                    ['step', ['get', 'count'], 5, 3, 6, 5, 7],
                    4,
                  ],
                  'line-opacity': dimOthers
                    ? ['case', ['==', ['get', 'trackId'], focusedTrackId ?? ''], 1, 0.25]
                    : 1,
                }}
              />
              <Layer
                id="tracks-heat-focus"
                type="line"
                filter={['==', ['get', 'trackId'], focusedTrackId ?? '']}
                paint={{ 'line-color': ['get', 'color'], 'line-width': 7, 'line-opacity': 1 }}
              />
            </GeoJSONSource>
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

          {/* Waypoint pins (saved standalone ones always; live ones while a
              recording session is up). Visual only — tap handling is done at
              the map level (onMapPress); MapLibre's <Marker onPress> doesn't
              fire on Android. */}
          {visiblePins.map((w) => (
            <Marker
              key={`${w.source}-${w.id}`}
              id={`${w.source}-${w.id}`}
              lngLat={[w.longitude, w.latitude]}
              anchor="bottom"
            >
              <WaypointMarkerPin
                hasPhoto={!!w.photoUri}
                label={w.label}
                selected={viewWp?.id === w.id && viewWp.source === w.source}
              />
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

      {/* Map maker: the same box selector in its bare variant, then options */}
      {makeMapState?.phase === 'select' && !terrain3d && (
        <RegionSelectOverlay
          variant="makeMap"
          toGeo={toGeo}
          boundsVersion={boundsVersion}
          activeBasemap={basemap}
          tileUrl={tileUrl}
          onCancel={() => setMakeMapState(null)}
          onConfirm={(rect) => {
            void resolveRegionRect(rect).then((bbox) => {
              if (bbox) setMakeMapState({ phase: 'options', bbox });
              else {
                setMakeMapState(null);
                showSnack('Could not read the map area — try again');
              }
            });
          }}
        />
      )}
      {(makeMapState?.phase === 'options' || makeMapState?.phase === 'generating') && (
        <MakeMapSheet
          bbox={makeMapState.bbox}
          progress={makeMapState.phase === 'generating' ? makeMapState.progress : null}
          onCreate={(options) => startMakeMap(makeMapState.bbox, options)}
          onCancel={() => {
            makeMapHandleRef.current.aborted = true;
            setMakeMapState(null);
          }}
        />
      )}

      {/* Top-left compass. The badge subscribes to the compass itself so the
          rapid heading events re-render only the badge, not this whole tree. */}
      <View style={[styles.topLeft, { top: insets.top + 8 }]} pointerEvents="box-none">
        <CompassBadge onPress={resetNorth} />
      </View>

      {/* Right-side map controls. Unmounted while the map-maker editor is up:
          its desk/drawer covers the rail visually, but a covered rail would
          still sit in the accessibility tree — screen readers (and E2E) could
          reach a hidden "Layers" behind the drawer's Layers tab. */}
      {makeMapState === null && (
        <MapControlsRail
          top={insets.top + 8}
          onLocate={() => {
            setFollowUser(true);
            // Also zoom in to a useful "where am I" level (~2.5 km across);
            // never zooms out if the user is already closer.
            if (location) void zoomToLocateLevel(location.latitude);
          }}
          showFitControl={overlays.length > 0}
          // Each press focuses the NEXT active PDF overlay, wrapping around —
          // with several maps loaded, repeated taps tour them all. A single
          // overlay behaves like the old fit-to-map.
          onFit={() => {
            const overlay = overlays[fitCycleRef.current % overlays.length];
            fitCycleRef.current += 1;
            if (overlay) fitOverlayBounds(overlay.bbox);
          }}
          terrain3d={terrain3d}
          pdfOverlayCount={overlays.length}
          trackOverlayCount={trackOverlays.length}
          minimalOpen={minimalControlsOpen}
          onMinimalOpenChange={setMinimalControlsOpen}
        />
      )}

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
          take over), while selecting an offline region, and while the trail
          inspector is open — its trim actions sit exactly where the FAB
          renders, which left the Overwrite button half-covered (#131). */}
      {status === 'idle' &&
        !selecting &&
        makeMapState === null &&
        inspectId === null &&
        // Minimal style folds the "+" dial away with the rest of the controls.
        (uiStyle !== 'minimal' || minimalControlsOpen) &&
        !pickingCategory && (
          <MapActionsFab
            onRecord={() => setPickingCategory(true)}
            onAddWaypoint={onAddWaypoint}
            // Close any open trail inspector first: the download sheet renders
            // below the inspector panel in this tree, so starting a download
            // with the inspector open left its controls buried under it (#131).
            onDownload={
              terrain3d || downloadProgress !== null || status !== 'idle'
                ? undefined
                : () => {
                    inspect(null);
                    beginRegionSelect();
                  }
            }
            // The region box needs the flat 2D map, like the download selector.
            onMakeMap={
              terrain3d
                ? undefined
                : () => {
                    inspect(null);
                    setMakeMapState({ phase: 'select' });
                    prepareRegionGeometry();
                  }
            }
          />
        )}

      {/* Category-first record start: sheet opens on "Record track"; Start
          actually begins the recording with the chosen category. */}
      <CategoryStartSheet
        visible={pickingCategory && status === 'idle'}
        onStart={(categoryId) => {
          setPickingCategory(false);
          startRecording(categoryId);
        }}
        onDismiss={() => setPickingCategory(false)}
      />

      <BackgroundLocationRationale visible={bgRationaleVisible} onRespond={respondToBgRationale} />

      {/* Read-only waypoint viewer (pin tap): coordinates/note/photo with copy
          actions. Hidden while the trail inspector or the editor is up so the
          bottom edge never stacks two cards. */}
      {inspectTrack === null && editWaypoint === null && (
        <WaypointViewerCard
          waypoint={viewWaypoint}
          onCopyCoords={() => {
            if (!viewWaypoint) return;
            void Clipboard.setStringAsync(
              formatLatLng(viewWaypoint.latitude, viewWaypoint.longitude),
            );
            showSnack('Coordinates copied');
          }}
          onCopyNote={() => {
            if (!viewWaypoint?.note) return;
            void Clipboard.setStringAsync(viewWaypoint.note);
            showSnack('Note copied');
          }}
          onSharePhoto={() => {
            const uri = viewWaypoint?.photoUri;
            if (!uri) return;
            void (async () => {
              if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
              else showSnack('Sharing is not available on this device');
            })();
          }}
          onEdit={() => {
            if (!viewWp) return;
            setEditWp(viewWp);
            setWpDraft(viewWaypoint?.note ?? '');
            setViewWp(null);
          }}
          onClose={() => setViewWp(null)}
        />
      )}

      <WaypointEditorDialog
        waypoint={editWaypoint}
        draft={wpDraft}
        onChangeDraft={setWpDraft}
        onSave={saveWaypoint}
        onDelete={deleteWaypoint}
        onSetPhoto={setWaypointPhoto}
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
