import { buildDownloadedMask } from '@core/geo/downloadedMask';
import { visibleMaps, visibleTrackIds, visibleWaypoints } from '@core/library/visibility';
import { resolveInitialCenter } from '@core/geo/lastKnownPosition';
import { offlinePackMaxZoom } from '@core/geo/tiles';
import { unionBoundingBoxes } from '@core/geo/geomath';
import { ECCC_ATTRIBUTION, weatherLayerById } from '@core/geo/weatherLayers';
import {
  modelVariableForLayer,
  modelWeatherTileUrl,
  weatherModelById,
} from '@core/weather/weatherModels';
import type { BoundingBox, LatLng, LngLat, TrackPoint } from '@core/models';
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
import { useFocusEffect, useRouter } from 'expo-router';
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
import { HeatPointCarousel } from './components/HeatPointCarousel';
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
import { toLineFeature, toLngLatBounds } from './geojson';
import { useAutoPauseOnLocationLoss } from './hooks/useAutoPauseOnLocationLoss';
import { useCameraControls } from './hooks/useCameraControls';
import { useHeadingCamera } from './hooks/useHeadingCamera';
import { useOfflineDownload } from './hooks/useOfflineDownload';
import { useRecordingSession } from './hooks/useRecordingSession';
import { useTrailInspection } from './hooks/useTrailInspection';
import { buildOsmStyle } from './mapStyle';
import { useLocationTracking } from './useLocation';
import { usePdfOverlays } from './usePdfOverlay';
import { useTerrainOverlays2D } from './useTerrainOverlays2D';
import { useTrackHeat } from './useTrackHeat';
import { useTrackOverlays } from './useTrackOverlays';
import { MarineDisclaimerChip } from './marine/MarineDisclaimerChip';
import { ForecastCard } from './weather/ForecastCard';
import { useWeatherTimeline } from './weather/useWeatherTimeline';
import { WeatherLegend } from './weather/WeatherLegend';
import { WeatherModelSheet } from './weather/WeatherModelSheet';
import { WeatherTimeScrubber } from './weather/WeatherTimeScrubber';
import { useTimedSnackbar } from '../common/useTimedSnackbar';

// Live-recording line throttle: rebuilding the LineString on every GPS fix
// re-serializes the entire track so far and pushes it across the bridge each
// fix. Rebuild at most once per TRAIL_REBUILD_MS or every TRAIL_REBUILD_POINTS
// new fixes, whichever comes first.
const TRAIL_REBUILD_MS = 1000;
const TRAIL_REBUILD_POINTS = 5;

// Fallback bottom padding for the select-trail camera fit, used only before
// TrailInspectPanel has ever reported its real height via onLayout (see
// inspectPanelHeight below) — e.g. the very first trail selected in a
// session. Generous on purpose: a slightly larger pad is a smaller trail
// on-screen, never a trail hidden under the panel.
const INSPECT_PANEL_H_ESTIMATE = 300;
// Breathing room between the panel's top edge and the fitted trail.
const INSPECT_PANEL_PAD = 24;

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
  // Pre-selection camera, captured just before the first selection-driven
  // camera fit (see the inspect-fit effect below) so a later FULL deselect
  // can glide smoothly back to it. Switching the selection from one trail to
  // another must NOT overwrite this — it only ever holds the view from
  // before selection started, until a deselect consumes and clears it.
  // Written only inside event handlers/effects, never during render.
  const restoreCameraRef = useRef<{ center: LngLat; zoom: number } | null>(null);

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
  // When the heatmap toggle is on, the heat layer + tap-carousel must source
  // EVERY track in the library, not just whatever the current visibility
  // mode/folder filters/activeTrackIds happen to show ("if heatmap is
  // selected, it shouldn't need the trace to be shown"). When it's off this
  // collapses to exactly shownTrackIds, so useTrackHeat's behavior — and its
  // GPX-load footprint — is byte-for-byte the pre-this-feature one: "when
  // heatmap is OFF, nothing changes". showHeatmap itself is declared below
  // (with the rest of the map-store/settings-store reads); read it here too
  // since allTrackIds must be computed before useTrackHeat is called.
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const allTrackIds = useMemo(
    () => (showHeatmap ? tracks.map((t) => t.id) : shownTrackIds),
    [showHeatmap, tracks, shownTrackIds],
  );
  const trackHeat = useTrackHeat(tracks, shownTrackIds, allTrackIds);
  const router = useRouter();
  // Tap-selected heat spot (set by onMapPress's hit-test below when a tap
  // lands on a "hot" spot with 2+ trails underneath it): drives the
  // HeatPointCarousel and which trail the heat layers highlight/dim. Null
  // just falls back to whichever trail is open in the inspect panel.
  const [heatSelection, setHeatSelection] = useState<{
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
  // Weather overlay (weather UX M1): the persisted GeoMet layer choice, the
  // transient play flag, and the scrubbable timeline that owns the drape's
  // valid time (throttled inside the hook). Network-only like the marked
  // trails: while offline-only is on the layer is dropped from the style
  // entirely and the timeline hook is parked, so the map stays byte-identical
  // to a weatherless one.
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  // M2: which ECCC model the forecast drapes resolve against (persisted;
  // radar ignores it). The model sheet floats above the scrubber, toggled by
  // its chevron — plain dock state, never a Portal.
  const weatherModel = useSettingsStore((s) => s.weatherModel);
  const setSettings = useSettingsStore((s) => s.set);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // Changing the LAYER closes the sheet (a fresh layer starts from the
  // scrubber, like Windy); switching models inside the sheet keeps it open.
  useEffect(() => {
    const t = setTimeout(() => setModelSheetOpen(false), 0);
    return () => clearTimeout(t);
  }, [weatherLayer]);
  const weatherAnimating = useMapStore((s) => s.weatherAnimating);
  const toggleWeatherAnimation = useMapStore((s) => s.toggleWeatherAnimation);
  const weatherTl = useWeatherTimeline(
    offlineOnly ? null : weatherLayer,
    weatherModel,
    weatherAnimating,
  );
  // Marine reference layers (marine M3): NONNA bathymetry / seamarks, same
  // network-only treatment as the marked trails. Any active layer also pins
  // the mandatory "Not for navigation" chip below.
  const marineLayers = useSettingsStore((s) => s.marineLayers);
  const marineActive = marineLayers.length > 0 && !offlineOnly;
  // Long-pressed point whose forecast/tides card is open (shown while a
  // weather or marine layer is active).
  const [forecastAt, setForecastAt] = useState<LatLng | null>(null);
  const style = useMemo(() => {
    const options = {
      // The 'edge' UI style washes the raster into pastels to match its chrome.
      pastel: uiStyle === 'edge',
      // Marked-trail networks (network-only; hidden while offline-only).
      markedTrailsNetworks: offlineOnly ? [] : markedTrailsNetworks,
      // Marine drapes ride the same offline-only rule.
      marineLayers: offlineOnly ? [] : marineLayers,
      ...(weatherLayer !== null && !offlineOnly
        ? {
            weather: {
              urlTemplate: modelWeatherTileUrl(weatherLayer, weatherModel, weatherTl.timeParam),
              attribution: ECCC_ATTRIBUTION,
            },
            // Windy-style muted background under weather: desaturated raster +
            // a neutral dim screen (theme-matched), city labels staying legible
            // through it — strong enough that the weather gradient reads as THE
            // content. See the option's doc for the raster-tile honesty note.
            weatherMuted: {
              dimColor: theme.dark ? '#101418' : '#F4F1EC',
              dimOpacity: theme.dark ? 0.45 : 0.38,
            },
          }
        : {}),
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
    marineLayers,
    weatherLayer,
    weatherModel,
    weatherTl.timeParam,
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
    liveSpeedMps,
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

  // Collapsed pill / expanded card — shared between StatsHud and
  // RecordControls (item 3: the buttons' row/column layout follows the same
  // state as the stats HUD's own expand toggle).
  const [hudExpanded, setHudExpanded] = useState(false);

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

  // One flag shared by the weather dock and the FAB lift (they must agree).
  const weatherDockVisible =
    weatherLayer !== null && !offlineOnly && !selecting && weatherTl.timeline !== null;

  // M2: the model-comparison table route, for the long-pressed point when a
  // forecast card is up, else the map centre (gated on mapLoaded — ungated
  // getViewState NPEs on the native thread), else the last known position.
  const openModelCompare = useCallback(() => {
    setModelSheetOpen(false);
    void (async () => {
      let at = forecastAt;
      if (at === null && mapLoaded) {
        try {
          const vs = await mapRef.current?.getViewState();
          if (vs !== undefined) at = { latitude: vs.center[1], longitude: vs.center[0] };
        } catch {
          // map mid-teardown — fall through to the stored position.
        }
      }
      at ??= lastKnownPosition ?? { latitude: 46.813, longitude: -71.208 };
      router.push({
        pathname: '/weather-compare',
        params: {
          lat: String(at.latitude),
          lng: String(at.longitude),
          layer: weatherLayer ?? '',
        },
      });
    })();
  }, [forecastAt, mapLoaded, lastKnownPosition, router, weatherLayer]);

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

  const { inspectId, inspectTrack, inspectPoints, markerAt, setMarkerAt, inspect } =
    useTrailInspection(tracks);
  // TrailInspectPanel's real measured height (via its onLayout), so the
  // select-trail camera fit below pads exactly above the panel instead of
  // guessing. Stays set across panel remounts (same trail-inspect layout
  // every time), so only the very first-ever selection in a session uses
  // the INSPECT_PANEL_H_ESTIMATE fallback before the first layout lands.
  const [inspectPanelHeight, setInspectPanelHeight] = useState<number | null>(null);

  // Trail inspect panel v4: fit the camera to the inspected trail's bbox in
  // the space ABOVE the (now-compact) panel, once its points load. Trimming
  // moved to the focused trail viewer (Trail3DGLScreen) — see its own
  // ?trim=1 handling — so `inspectId` is now only ever set by a MAP tap
  // (onMapPress below); the Library's "View on map" action uses focusBounds
  // instead and never opens this panel.
  useEffect(() => {
    const bbox = inspectTrack?.stats.bbox;
    if (!inspectId || !inspectPoints || !bbox) return;
    setFollowUser(false);
    const bounds = toLngLatBounds(bbox);
    const padding = {
      top: insets.top + 80,
      left: 40,
      right: 40,
      bottom: (inspectPanelHeight ?? INSPECT_PANEL_H_ESTIMATE) + INSPECT_PANEL_PAD,
    };
    const fit = () => cameraRef.current?.fitBounds(bounds, { duration: 600, padding });
    // Capture the camera as it stood BEFORE this selection-driven fit — but
    // only once per selection "session" (the ref-is-null check): switching
    // from one selected trail to another must not clobber the true
    // pre-selection view held for the eventual deselect glide-back (see
    // restoreCameraOnDeselect). Gated on mapLoaded — see its declaration
    // comment (ungated getViewState NPEs on the native thread).
    if (restoreCameraRef.current === null && mapLoaded) {
      void mapRef.current
        ?.getViewState()
        .then((vs) => {
          restoreCameraRef.current = { center: vs.center, zoom: vs.zoom };
        })
        .catch(() => {
          // map mid-teardown — skip capturing; the deselect glide-back just
          // won't fire this one time.
        })
        .finally(fit);
    } else {
      fit();
    }
    // `setFollowUser` is a stable setter wrapper; `insets.top` is effectively
    // constant per device/orientation. `inspectPanelHeight` IS a real dep:
    // when the very first-ever panel layout lands after this effect already
    // fit with the estimate, this reruns to re-fit with the real padding —
    // safe because the restoreCameraRef guard below only captures once per
    // selection "session", so the re-fit never re-captures the (now
    // already-moved) view as the restore target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectId, inspectPoints, inspectTrack, inspectPanelHeight]);

  // Glide the camera back to its pre-selection view on a FULL deselect (the
  // effect above is the only thing that ever populates restoreCameraRef) —
  // called from the three close paths below (inspect-panel close, carousel
  // close, cold-tap deselect), never when merely switching the selected
  // trail. Clears the ref so a redundant deselect is a no-op.
  const restoreCameraOnDeselect = useCallback(() => {
    const prev = restoreCameraRef.current;
    if (!prev) return;
    restoreCameraRef.current = null;
    void cameraRef.current?.setStop({ center: prev.center, zoom: prev.zoom, duration: 600 });
  }, []);

  // Item 5: when the heat-spot carousel OPENS, zoom the camera OUT to fit the
  // union of every trail it's showing (not just the focused one) — capturing
  // the pre-open camera first via the SAME restoreCameraRef mechanism the
  // inspect-panel fit above uses, so the carousel's own onClose (which
  // already calls restoreCameraOnDeselect) glides back to it with no further
  // wiring. Keyed on heatSelection?.trackIds's REFERENCE — that array is
  // reused as-is by onFocus (`{...cur, focusedIdx}`), so this only fires once
  // per carousel "open", not on every focused-card swipe.
  useEffect(() => {
    if (!heatSelection) return;
    const boxes = heatSelection.trackIds
      .map((id) => tracks.find((t) => t.id === id)?.stats.bbox)
      .filter((b): b is BoundingBox => b !== undefined);
    const union = unionBoundingBoxes(boxes);
    if (!union) return;
    setFollowUser(false);
    // Border-to-border on purpose (owner feedback 2026-08-06: the 25% bbox
    // inflation + deck-clearing margins landed way too zoomed out): fit the
    // union bbox itself, with just enough pixel padding that the trail's
    // line width and end markers aren't clipped by the very edge — the
    // carousel deck overlapping a corner of the fit is accepted.
    const bounds = toLngLatBounds(union);
    const padding = { top: insets.top + 16, left: 16, right: 16, bottom: 16 };
    const fit = () => cameraRef.current?.fitBounds(bounds, { duration: 600, padding });
    if (restoreCameraRef.current === null && mapLoaded) {
      void mapRef.current
        ?.getViewState()
        .then((vs) => {
          restoreCameraRef.current = { center: vs.center, zoom: vs.zoom };
        })
        .catch(() => {
          // map mid-teardown — skip capturing; the close glide-back just
          // won't fire this one time.
        })
        .finally(fit);
    } else {
      fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatSelection?.trackIds]);

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
  // Item 4: tapping the user's own position dot re-enables follow mode —
  // same screen-projection hit-test idiom as the waypoint pins below, just
  // against the single live location instead of a list of pins.
  const USER_LOCATION_HIT_PX = 40;
  // Tap-routing priority (this handler, in order): waypoint pin hit → the
  // existing viewer-card behaviour below; else a heat-spot lookup — a "hot"
  // spot (2+ trails, overlapping) opens the carousel, a single cold trail
  // opens the inspect panel; else the user-location dot (re-engage follow,
  // item 4 — deliberately LAST, see tapHitsUserDot below); else deselect.
  //
  // The event's real (runtime + typings) shape is `nativeEvent: { lngLat:
  // [lng, lat]; point: [x, y]; ... }` — flat tuples, NOT the GeoJSON
  // `{ geometry: { coordinates } }` shape one might expect from a "feature
  // press" event. Confirmed against
  // node_modules/@maplibre/maplibre-react-native's PressEvent type.
  const onMapPress = useCallback(
    async (e: { nativeEvent?: { point?: [number, number]; lngLat?: [number, number] } }) => {
      const point = e.nativeEvent?.point;
      const map = mapRef.current;
      if (!point || !map) return;
      const [px, py] = point;

      // Item 4, demoted to the LOWEST tap priority (2026-08-06 field
      // regression): the user-location dot re-engages follow ONLY when the
      // tap hits nothing else — waypoint pins, hot spots and single-trail
      // taps all win over it. On a real library every activity starts and
      // ends at the user's usual spot, so the hottest heat cluster sits
      // exactly under the dot; with the dot checked FIRST, tapping that
      // cluster silently flipped follow on and the carousel never opened
      // ("clickability of the heatmap/trace does not work anymore", 1.5.0).
      // Only while follow is OFF — while following, the dot is pinned at
      // the camera centre and the route is meaningless. Fresh-read via
      // getState(): follow can flip between renders (Locate, pan-away) and
      // a stale closure here would misroute the very next tap.
      const tapHitsUserDot = async (): Promise<boolean> => {
        if (!location || useMapStore.getState().followUser) return false;
        try {
          const userPx = await map.project([location.longitude, location.latitude]);
          return (
            userPx != null && Math.hypot(px - userPx[0], py - userPx[1]) < USER_LOCATION_HIT_PX
          );
        } catch {
          return false; // projection unavailable mid-teardown — no dot hit
        }
      };

      let best: (typeof visiblePins)[number] | null = null;
      if (visiblePins.length > 0) {
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
      }
      if (best) {
        // Pin tap opens the read-only viewer; a second tap on the same pin
        // (or the card's ✕) closes it. Editing is the card's explicit step.
        setViewWp((cur) =>
          cur?.id === best.id && cur.source === best.source
            ? null
            : { source: best.source, id: best.id },
        );
        return;
      }

      // No waypoint pin hit — route through the heat lookup, but only when
      // trail overlays are actually shown: with the master switch off, no
      // trail/heat geometry is on screen at all (rendering is gated the same
      // way below), so a tap there must fall through to plain deselect. This
      // is the master switch only — heatAt itself (and the heatmap layer) is
      // NOT gated on any individual trail's trace visibility, so a hot spot
      // opens the carousel (and a single non-hot tap opens inspect for a
      // shown trail) regardless of the current visibility mode/folder
      // filters/activeTrackIds; see useTrackHeat.
      const lngLatArr = e.nativeEvent?.lngLat;
      const at =
        lngLatArr && showTrackOverlays
          ? trackHeat.heatAt({ lng: lngLatArr[0], lat: lngLatArr[1] })
          : { trackIds: [], hot: false };
      if (lngLatArr && at.hot && at.trackIds.length >= 2) {
        inspect(null); // opening the carousel hides the inspect panel
        setHeatSelection({
          lngLat: { lng: lngLatArr[0], lat: lngLatArr[1] },
          trackIds: at.trackIds,
          focusedIdx: 0,
        });
      } else if (at.trackIds.length === 1) {
        setHeatSelection(null); // a single-trail tap hides the carousel
        inspect(at.trackIds[0] ?? null);
      } else {
        // Nothing else claimed the tap — the dot route gets its turn now
        // (item 4: tap your own position dot to resume following after
        // panning away). Checked last so it can never steal a heat-spot,
        // trail or waypoint tap that happens to sit under the dot.
        if (await tapHitsUserDot()) {
          setFollowUser(true);
          return;
        }
        // Empty/cold tap: deselect both the carousel and any open inspect
        // panel (item 7 — tapping empty map while a trail is selected
        // deselects it, same as tapping empty space anywhere else), and
        // glide the camera back to its pre-selection view.
        setHeatSelection(null);
        inspect(null);
        restoreCameraOnDeselect();
      }
      setViewWp(null); // tapping empty map dismisses the waypoint viewer
      setForecastAt(null); // ... and the forecast card
    },
    [
      visiblePins,
      trackHeat,
      inspect,
      showTrackOverlays,
      restoreCameraOnDeselect,
      location,
      setFollowUser,
    ],
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

  // Which trail is "selected": a tap-selected heat spot (the carousel) wins,
  // otherwise whichever trail is open in the inspect panel. When ANY trail is
  // selected, every other trail is hidden outright (not dimmed) via the lines
  // layer's filter below — see item 1's selection-visibility rule.
  const focusedTrackId = heatSelection
    ? (heatSelection.trackIds[heatSelection.focusedIdx] ?? null)
    : inspectId;
  const hasSelection = heatSelection !== null || inspectId !== null;

  // The focused trail's own geometry, looked up independent of shown-trail
  // membership: a hot-spot carousel selection can point at a globally-
  // qualifying trail whose trace is currently hidden (Content: everything,
  // nothing active) — "clickability" of the heatmap means that trail must
  // still be able to draw its highlight. Drawn as its own layer below,
  // separate from the shown-trails source, so it renders regardless.
  const focusLine = useMemo(
    () => (focusedTrackId ? trackHeat.lineFor(focusedTrackId) : null),
    [focusedTrackId, trackHeat],
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
      ) : !settingsHydrated ? null : ( // wait for the persisted camera seed (a few ms at launch)
        <Map
          ref={mapRef}
          style={styles.fill}
          mapStyle={style}
          // Owner call (backlog item 1): the bottom-left ornaments — MapLibre's
          // wordmark logo and the attribution "i" — take too much map. Both are
          // off; the OSM/Esri data credit lives in Settings → About instead
          // ("Maps & data"), which is where the store listings also point.
          attribution={false}
          logo={false}
          // We draw our own compass badge (top-left), so hide MapLibre's native
          // compass — when the map is rotated it otherwise appears in the top-right,
          // peeking out behind our locate button as a stray dark circle.
          compass={false}
          touchPitch
          onPress={onMapPress}
          // Weather/marine gesture: long-press opens the forecast card (ECCC
          // forecast + CHS tides) for that point. Gated on an active weather
          // OR marine layer (and online) so the map behaves exactly like
          // today when both are off.
          onLongPress={(e: { nativeEvent?: { lngLat?: [number, number] } }) => {
            const lngLat = e.nativeEvent?.lngLat;
            if (!lngLat || (weatherLayer === null && !marineActive) || offlineOnly) return;
            setForecastAt({ longitude: lngLat[0], latitude: lngLat[1] });
          }}
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

          {/* Heatmap density: a native MapLibre `heatmap` layer under the
              trail lines, built from sampled points of EVERY qualifying
              trail in the library (useTrackHeat.heatPoints — global while
              the toggle is on, independent of visibility mode/folder
              filters/activeTrackIds, bounded feature count regardless of how
              many/long those trails are — see qualifiesForHeat). Tight
              dots/streaks at province/city zoom (small radius, low intensity
              — DENSITY carries the "hot" signal, not blob size), growing
              into a corridor wash as you zoom toward street level. Capped at
              a warm orange (no dark/red-brown top) and faded slightly above
              z15 once the trail lines themselves carry the detail. Drawn
              BEFORE the lines below so it sits beneath them. */}
          {showTrackOverlays && showHeatmap && trackHeat.heatPoints && (
            <GeoJSONSource id="tracks-heat-points" data={trackHeat.heatPoints}>
              <Layer
                id="tracks-heatmap"
                type="heatmap"
                paint={{
                  'heatmap-weight': 1,
                  'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 16, 1.0],
                  'heatmap-color': [
                    'interpolate',
                    ['linear'],
                    ['heatmap-density'],
                    0,
                    'rgba(255,140,0,0)',
                    0.15,
                    'rgba(255,140,0,0)',
                    0.4,
                    'rgba(255,140,0,0.18)',
                    0.7,
                    'rgba(255,130,0,0.35)',
                    1,
                    'rgba(255,120,0,0.55)',
                  ],
                  'heatmap-radius': [
                    'interpolate',
                    ['exponential', 1.6],
                    ['zoom'],
                    6,
                    3,
                    10,
                    8,
                    13,
                    16,
                    16,
                    28,
                  ],
                  'heatmap-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    0,
                    0.5,
                    15,
                    0.5,
                    18,
                    0.35,
                  ],
                }}
              />
            </GeoJSONSource>
          )}

          {/* Trail lines: every shown trail as a thin, clean, category-
              coloured LineString — no glow layer, no width stepping (see
              useTrackHeat). When a trail is selected (a tap-selected heat
              spot OR the inspect panel), every trail from THIS shown-trails
              source is hidden outright (not dimmed) — the focused trail's
              highlight is drawn by the dedicated "focused-trail" layer just
              below instead, since a hot-spot selection can point at a
              trail outside the shown set (heatmap clickability works even
              with traces hidden). Tapping a "hot" spot routes through
              onMapPress below to open the HeatPointCarousel; the per-trail
              onPress this replaced is gone for good — the map-level hit-test
              (heatAt) is the only way in now. */}
          {showTrackOverlays && trackHeat.lines && (
            <GeoJSONSource id="tracks-lines" data={trackHeat.lines}>
              <Layer
                id="tracks-lines-layer"
                type="line"
                filter={hasSelection ? false : true}
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': ['get', 'color'],
                  'line-width': 3,
                }}
              />
            </GeoJSONSource>
          )}

          {/* Focused-trail highlight: the selected trail's own geometry
              (useTrackHeat.lineFor), drawn independent of whether it's in
              the shown-trails source above — this is what makes a hot-spot
              carousel tap "clickable" even with traces hidden entirely
              (Content: everything, nothing active). Not gated on
              showTrackOverlays: a selection can only exist from a tap that
              already required trail overlays / the heatmap, so this layer
              simply follows whether there's a trail to draw. */}
          {focusLine && (
            <GeoJSONSource id="focused-trail-line" data={focusLine}>
              <Layer
                id="focused-trail-line-layer"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{ 'line-color': ['get', 'color'], 'line-width': 4 }}
              />
            </GeoJSONSource>
          )}

          {/* Ring marker at the tapped heat spot, shown only while the
              carousel is open — same one-feature GeoJSONSource + circle
              pattern as the inspect-marker dot below. */}
          {heatSelection && (
            <GeoJSONSource
              id="heat-tap-marker"
              data={{
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [heatSelection.lngLat.lng, heatSelection.lngLat.lat],
                },
                properties: {},
              }}
            >
              <Layer
                id="heat-tap-marker-ring"
                type="circle"
                paint={{
                  'circle-radius': 9,
                  'circle-color': 'transparent',
                  'circle-stroke-width': 2.5,
                  'circle-stroke-color': theme.colors.primary,
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

      {/* Mandatory marine notice (marine M3): whenever a marine layer is
          draped, the "Not for navigation" chip pins top-centre — between the
          compass (left) and the controls rail (right). A plain overlay chip
          like the GPS warning, never a Portal/Dialog. 2D only: the 3D view
          doesn't drape marine layers. */}
      {marineActive && !terrain3d && (
        <View style={[styles.marineChip, { top: insets.top + 12 }]} pointerEvents="none">
          <MarineDisclaimerChip />
        </View>
      )}

      {/* Right-side map controls. Unmounted while the map-maker editor is up:
          its desk/drawer covers the rail visually, but a covered rail would
          still sit in the accessibility tree — screen readers (and E2E) could
          reach a hidden "Layers" behind the drawer's Layers tab. Also
          unmounted while the heat carousel is open — the deck now renders
          directly over the rail's footprint (top-right), so a covered rail
          would again leave hidden nodes in the a11y tree; it comes back the
          instant the carousel closes (heatSelection back to null). */}
      {makeMapState === null && heatSelection === null && (
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

      {/* Bottom HUD + controls. Item 3: a single row so the stats HUD and the
          three record buttons share one layout — collapsed centers the
          (small) pill against the (bigger) icon buttons so they pop slightly
          out of the bar; expanded bottom-aligns the smaller card on the left
          against the buttons stacked vertically to its right. */}
      {/* Item 2: with the map logo/attribution gone, the recording UI drops
          into the freed bottom-left space — a much smaller pad clears more
          map above it. */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 4 }]} pointerEvents="box-none">
        {/* Hide the recording UI while the region-select overlay is open so the
            Record button doesn't sit on top of the overlay's Confirm/Cancel bar. */}
        {!selecting && status !== 'idle' && (
          <View
            style={hudExpanded ? styles.recordingBarExpanded : styles.recordingBarCollapsed}
            pointerEvents="box-none"
          >
            {/* flexShrink guard (backlog item 3): the HUD must yield width to
                the buttons, never push them off-screen — after an
                expand→collapse cycle iOS re-lays the pill out wide (the Paper
                Surface flex quirk) and without this the third button left the
                screen. */}
            <View style={styles.hudShrink} pointerEvents="box-none">
              <StatsHud
                name={name}
                stats={stats}
                elapsedS={elapsedS}
                liveSpeedMps={liveSpeedMps}
                paused={status === 'paused'}
                gpsQuality={gpsQuality}
                expanded={hudExpanded}
                onToggleExpanded={() => setHudExpanded((e) => !e)}
              />
            </View>
            <RecordControls
              status={status}
              expanded={hudExpanded}
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
        )}
        {/* Weather dock (weather UX M1): the value-legend pill + time
            scrubber, riding the same bottom flex column as the recording bar
            — the column stacks them, so they never overlap it. Hidden with
            the recording UI while the region-select overlay owns the bottom
            edge, and offline-only parks weather entirely. */}
        {weatherDockVisible && weatherTl.timeline !== null && (
          <View style={styles.weatherDock} pointerEvents="box-none">
            {/* M2: the model sheet floats above the legend+scrubber in the
                same dock column (right-aligned over the chevron that opened
                it). Forecast layers only — radar is model-less. */}
            {modelSheetOpen && weatherTl.timeline.kind === 'forecast' && (
              <WeatherModelSheet
                selected={weatherModel}
                onSelect={(id) => setSettings('weatherModel', id)}
                onCompare={openModelCompare}
              />
            )}
            <WeatherLegend layer={weatherLayerById(weatherLayer)} />
            <WeatherTimeScrubber
              timeline={weatherTl.timeline}
              selectedIdx={weatherTl.selectedIdx}
              selectedMs={weatherTl.selectedMs}
              onScrub={weatherTl.scrubTo}
              playing={weatherAnimating}
              onTogglePlay={toggleWeatherAnimation}
              onOpenModelPicker={
                weatherTl.timeline.kind === 'forecast'
                  ? () => setModelSheetOpen((o) => !o)
                  : undefined
              }
              modelPickerOpen={modelSheetOpen}
              modelCaption={
                weatherTl.timeline.kind === 'forecast'
                  ? `${weatherModelById(weatherModel).label} ${weatherModelById(weatherModel).horizonLabel.toUpperCase()}`
                  : undefined
              }
            />
          </View>
        )}
      </View>

      {inspectId && inspectPoints && inspectTrack && (
        <TrailInspectPanel
          track={inspectTrack}
          points={inspectPoints}
          onClose={() => {
            inspect(null);
            restoreCameraOnDeselect();
          }}
          onScrub={setMarkerAt}
          onView={() => router.push(`/trail3d/${inspectTrack.id}`)}
          onLayout={setInspectPanelHeight}
        />
      )}

      {/* Right-edge activity carousel: opened by tapping a "hot" heat spot
          (onMapPress above). Mutually exclusive with TrailInspectPanel — the
          two setters clear each other, never both open at once. */}
      {heatSelection && (
        <HeatPointCarousel
          trackIds={heatSelection.trackIds}
          tracks={tracks}
          focusedIdx={heatSelection.focusedIdx}
          onFocus={(idx) => {
            setHeatSelection((cur) => {
              if (!cur) return cur;
              // Bound-check against the current trail count — the dim
              // expression above indexes trackIds[focusedIdx] and must never
              // see an out-of-range index.
              const clamped = Math.max(0, Math.min(idx, cur.trackIds.length - 1));
              return { ...cur, focusedIdx: clamped };
            });
          }}
          onOpenTrail={(id) => router.push(`/trail3d/${id}`)}
          onClose={() => {
            setHeatSelection(null);
            restoreCameraOnDeselect();
          }}
          topInset={insets.top}
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
        // The model sheet opens exactly where the lifted FAB sits (above the
        // weather dock's corner) — hide the FAB while the sheet is up.
        !(weatherDockVisible && modelSheetOpen) &&
        // Minimal style folds the "+" dial away with the rest of the controls.
        (uiStyle !== 'minimal' || minimalControlsOpen) &&
        !pickingCategory && (
          <MapActionsFab
            // The weather dock (legend 22 + gap 6 + scrubber 54 + column gap)
            // owns the FAB's corner while visible — hop above it.
            liftBy={weatherDockVisible ? 96 : 0}
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

      {/* ECCC forecast card (weather long-press): nearest citypage forecast +
          the gridded value under the finger. Same bottom-card slot rules as
          the waypoint viewer — hidden while other bottom cards are up. */}
      {forecastAt !== null &&
        (weatherLayer !== null || marineActive) &&
        !offlineOnly &&
        inspectTrack === null &&
        editWaypoint === null &&
        viewWaypoint === null && (
          <ForecastCard
            at={forecastAt}
            layer={weatherLayer}
            marineActive={marineActive}
            onClose={() => setForecastAt(null)}
            // M2: the comparison-table entry from the tap-card (forecast
            // layers only — the table has nothing to say about radar).
            onCompareModels={
              weatherLayer !== null && modelVariableForLayer(weatherLayer) !== null
                ? openModelCompare
                : undefined
            }
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
  // Centred between the compass (left) and the controls rail (right).
  marineChip: { position: 'absolute', left: 60, right: 60, alignItems: 'center' },
  banner: { position: 'absolute', left: 8, right: 8, borderRadius: 12 },
  bottom: { position: 'absolute', left: 12, right: 12, bottom: 0, gap: 14 },
  // Collapsed: center-align the pill against the (bigger) icon buttons so
  // they visibly pop out of the bar (item 3).
  recordingBarCollapsed: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  // The HUD yields width before the record buttons do (see the guard's
  // comment at the call site).
  hudShrink: { flexShrink: 1 },
  // Expanded: bottom-align the (smaller) card on the left against the
  // buttons stacked vertically to its right (item 3).
  recordingBarExpanded: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  // Legend pill + time scrubber, tight together (the bottom column's own gap
  // is for separating whole blocks like the recording bar).
  weatherDock: { gap: 6 },
});
