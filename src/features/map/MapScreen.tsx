import { MapAreaBottomContext, useWindowEdge } from './mapAreaBottom';
import { reportError } from '@lib/errorReporting';
import { fnv1a32 } from '@core/encoding/fnv1a';
import {
  nearestPinAt,
  projectablePins,
  unprojectablePins,
  WAYPOINT_PIN_HIT,
  type ProjectedPin,
} from '@core/geo/pinHitTest';
import {
  chipSurvivesHit,
  pointChipAfterBareTap,
  readMapPress,
  routeMapTap,
  type MapPress,
  type MapPressEvent,
  type PointChipHit,
} from '@core/map/mapTap';
import {
  CONTOUR_RECOVERY_ENABLED,
  MARINE_ENABLED,
  VECTOR_BASEMAP_ENABLED,
  WEATHER_ENABLED,
} from '@core/features/flags';
import { carouselFitPadding } from '@core/geo/cameraFit';
import { buildDownloadedMask } from '@core/geo/downloadedMask';
import { pdfOverlayMaps, visibleTrackIds, visibleWaypoints } from '@core/library/visibility';
import { resolveInitialCenter } from '@core/geo/lastKnownPosition';
import {
  MARINE_PACK_SNOOZE_MS,
  encodePackSnooze,
  marinePackOffer,
  snoozedPackRegions,
} from '@core/geo/marinePacks';
import type { MarineLayerId } from '@core/geo/marineLayers';
import { offlinePackMaxZoom } from '@core/geo/tiles';
import { unionBoundingBoxes } from '@core/geo/geomath';
import { weatherLayerById } from '@core/geo/weatherLayers';
import {
  modelVariableForLayer,
  resolveModelWmsLayer,
  weatherModelById,
} from '@core/weather/weatherModels';
import type { BoundingBox, LatLng, TrackPoint, WaypointIcon } from '@core/models';
import { resolveEffectiveModel } from '@core/weather/modelCoverage';
import { WEATHER_DRAPE_OPACITY } from '@core/weather/weatherLook';
import { WIND_DRAPE_OPACITY } from '@core/weather/windLook';
import { GESTURE_SETTLE_MS } from '@core/weather/windPerf';
import type { WindBbox } from '@core/weather/windCoverage';
import type { WindViewState } from '@core/weather/windProjection';
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Images,
  ImageSource,
  Layer,
  Map,
  type MapRef,
  Marker,
  UserLocation,
  type ViewState,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { useLibraryStore } from '@state/libraryStore';
import { useLongTrailsStore } from '@state/longTrailsStore';
import { useMapStore } from '@state/mapStore';
import { useRecorderStore } from '@state/recorderStore';
import { useMarinePackStore } from '@state/marinePackStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { createGesturePause } from '@core/support/gesturePause';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Banner, Snackbar, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RegionSelectOverlay } from './RegionSelectOverlay';
import { MapMakerEditor, type EditorCamera } from './mapmaker/MapMakerEditor';
import { useMakeMapSession } from './mapmaker/useMakeMapSession';
import { printStyleById, type PrintStyleId } from '@core/mapmaker/printSources';
import { clampZoom } from '@core/mapmaker/cameraFit';
import { EDITOR_RASTER_TILE_SIZE } from '@core/mapmaker/printSources';
import { discardDraftPhoto, withDraftPhoto, type WaypointDraft } from './waypointDraft';
import { BackgroundLocationRationale } from './components/BackgroundLocationRationale';
import { CategoryStartSheet } from './components/CategoryStartSheet';
import { CompassBadge } from './components/CompassBadge';
import { DestinationChip } from './components/DestinationChip';
import { DestinationMarkerPin } from './components/DestinationMarkerPin';
import { GoToCoordinatesDialog } from './components/GoToCoordinatesDialog';
import { MapCreditsButton, MapCreditsSheet } from './components/MapCredits';
import { mapCredits } from '@core/map/mapCredits';
import { bareTapAfterFocus } from '@core/map/mapTap';
import { HeadingCone } from './components/HeadingCone';
import { MapSearchPill } from './components/MapSearchPill';
import { PlaceSearchSheet } from './search/PlaceSearchSheet';
import { SearchHitMarker } from './search/SearchHitMarker';
import { cameraTargetFor } from '@core/search/camera';
import type { Place } from '@core/search/place';
import { usePlaceRecentsStore } from '@state/placeRecentsStore';
import {
  geodeticTilesUrl,
  tideTilesUrl,
  imageryContoursOption,
  vectorBasemapOption,
  vectorContoursUrl,
  vectorGlyphsUrl,
} from '@data/basemapTiles';
import { pickTappedMark, type GeodeticMark } from '@core/geodetic/record';
import { GEODETIC_TAP_LAYERS, geodeticColors } from '@core/map/geodeticStyle';
import { cardCameraCenterPx } from '@core/map/cardCamera';
import { buildGeodeticFilters } from '@core/geodetic/filter';
import { GeodeticPointCard } from './components/GeodeticPointCard';
import type { TideStation } from '@core/tides/station';
import { tideColors } from '@core/map/tideStyle';
import { TideStationCard } from './components/TideStationCard';
import { tideImages } from './tideImages';
import { tideStationAt } from './tideTap';
import { useChsStations } from './hooks/useChs';
import { geodeticImages } from './geodeticImages';
import { overlayAnchor } from '@core/map/layerSlots';
import { PuckLayers } from './components/PuckLayers';
import { NightExitPill } from '@features/display/NightExitPill';
import { useDisplayCondition } from '@ui/displayCondition';
import { NIGHT_MAP } from '@ui/tokens';
import { HeatPointCarousel } from './components/HeatPointCarousel';
import { ShownTrailPill, ShownTrailSheet } from './longTrail/ShownTrailChrome';
import { ShownTrailLayers } from './longTrail/ShownTrailLayers';
import { MapControlsRail } from './components/MapControlsRail';
import { RenderingToasts } from './components/RenderingToasts';
import { ScaleBar } from './components/ScaleBar';
import { metersPerPixel } from '@core/geo/scaleBar';
import { heatTapRadiusPx } from '@core/heat/heatStyle';
import { RecordingPanel } from './components/RecordingPanel';
import { TrailInspectPanel } from './components/TrailInspectPanel';
import { TipButton } from '@features/support/TipButton';
import { TipBubble } from '@features/support/TipBubble';
import { WaypointEditorDialog } from './components/WaypointEditorDialog';
import { WaypointMarkerPin } from './components/WaypointMarkerPin';
import { WaypointViewerCard } from './components/WaypointViewerCard';
import { BOTTOM_LAYER, snackbarWrapperStyle, waypointCardDockStyle } from './bottomLayers';
import { formatLatLng } from '@core/geo/formatCoords';
import { destinationReadout } from '@core/geo/destination';
import { nextWaypointLabel } from '@core/library/waypoints';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { toLineFeature, toLngLatBounds, type TrailLineFeature } from './geojson';
import { useAutoPauseOnLocationLoss } from './hooks/useAutoPauseOnLocationLoss';
import { useCameraControls } from './hooks/useCameraControls';
import { useContourRecovery } from './hooks/useContourRecovery';
import { useHeadingCamera } from './hooks/useHeadingCamera';
import { useMapBearing } from './hooks/useMapBearing';
import { useOfflineDownload } from './hooks/useOfflineDownload';
import { useRecordingSession } from './hooks/useRecordingSession';
import { useTrailInspection } from './hooks/useTrailInspection';
import { useSelectionCamera } from './hooks/useSelectionCamera';
import {
  CONTOUR_LAYERS,
  FOCUSED_TRAIL_LAYERS,
  SLOPE_LAYER,
  pdfDetailLayer,
  pdfOverviewLayer,
  HEAT_LAYERS,
  INSPECT_MARKER_LAYER,
  LINE_OUTLINE,
  LIVE_TRAIL_LAYERS,
  TRACKS_LINES_LAYERS,
  lineOutlineFor,
} from './mapLayers';
import { mapColors } from '@ui/theme';
import {
  buildOsmStyle,
  CONTOUR_LINE_LAYER_IDS,
  CONTOUR_SOURCE_MAXZOOM,
  CONTOUR_SOURCE_MINZOOM,
  HILLSHADE_2D_LAYER_ID,
  HILLSHADE_DEM_SOURCE_ID,
  TILT_RELIEF_LAYER_ID,
  VECTOR_CONTOURS_SOURCE,
} from './mapStyle';
import { useNativeTerrain, useNativeTerrainScene } from './hooks/useNativeTerrain';
import type { DrapeStyleInput } from '@core/terrain3d/drapeStyle';

import { sceneLines, type TerrainLineSpec } from '@core/terrain3d/sceneInput';
import { useTerrainQa } from './hooks/useTerrainQa';
import { useTiltRelief } from './hooks/useTiltRelief';
import { useLocationTracking } from './useLocation';
import { usePdfOverlays } from './usePdfOverlay';
import { usePdfDetails } from './usePdfDetails';
import { useTerrainOverlays2D } from './useTerrainOverlays2D';
import { useCullRegion } from './useCullRegion';
import { useTrackHeat } from './useTrackHeat';
import { useGeoJsonString } from './useGeoJsonString';
import { MarineDisclaimerChip } from './marine/MarineDisclaimerChip';
import { MarinePackBanner } from './marine/MarinePackBanner';
import { DepthPointLine } from './marine/DepthPointLine';
import { MarineLegend } from './marine/MarineLegend';
import { marineChartSource, useMarineChart } from './marine/useMarineChart';
import { MapPointChip, MapPointLine, hitMapPointChip } from './components/MapPointChip';
import { ForecastCard } from './weather/ForecastCard';
import { WindParticleLayer } from './weather/wind/WindParticleLayer';
import { useWeatherCrossfade } from './weather/useWeatherCrossfade';
import { useWeatherDrape } from './weather/useWeatherDrape';
import { WeatherDrapeLayers } from './weather/WeatherDrapeLayers';
import { MarineDrapeLayer, MarineSoundingsLayer } from './marine/MarineChartLayers';
import { useOverlayLabelTiles } from './useOverlayLabelTiles';
import { useWeatherTimeline } from './weather/useWeatherTimeline';
import { WeatherLegend } from './weather/WeatherLegend';
import { WeatherModelSheet } from './weather/WeatherModelSheet';
import { WeatherPointLine } from './weather/WeatherPointLine';
import { WeatherTimeScrubber } from './weather/WeatherTimeScrubber';
import { useTimedSnackbar } from '../common/useTimedSnackbar';
import { useMapDrawing } from './draw/useMapDrawing';

/** Kept out of the 3D drape: the 2D tilted-relief pass (the mesh is the relief). */
const TERRAIN_DRAPE_DROP_IDS: readonly string[] = [TILT_RELIEF_LAYER_ID];
/** Height (px) of the floating search row under the status bar: 3D pins stay below it. */
const TERRAIN_PIN_TOP_CHROME = 72;
/** The scale-bar row at the map's bottom edge: 3D pins stay above it. */
const TERRAIN_PIN_BOTTOM_CHROME = 56;
/** Softened in the drape: the contour lines and (over satellite) their casings. */
const TERRAIN_DRAPE_CONTOUR_IDS: readonly string[] = CONTOUR_LINE_LAYER_IDS.flatMap((id) => [
  id,
  `${id}-casing`,
]);

/** The heat-tap ring mounts with the other markers (`@core/map/layerSlots`). */
const MARKERS_ANCHOR = overlayAnchor('markers');

/** The search pill and its row below the safe-area top: the map's top chrome, px. */
const MAP_TOP_CHROME_PX = 60;

/** Half the side of the box a tap searches for a geodetic mark, px (DESIGN §7.2: ~12). */
const GEODETIC_HIT_PX = 12;

/** Our glyph host for the geodetic ID labels, when the build has one. */
function geodeticGlyphs(): { glyphs?: string } {
  const glyphs = vectorGlyphsUrl();
  return glyphs !== null ? { glyphs } : {};
}

// Live-recording line throttle: rebuilding the LineString on every GPS fix
// re-serializes the entire track so far and pushes it across the bridge each
// fix. Rebuild at most once per TRAIL_REBUILD_MS or every TRAIL_REBUILD_POINTS
// new fixes, whichever comes first.
/** Stable empty id list: trail overlays switched off (#465). */
const NO_IDS: readonly string[] = [];

/** Stable empty line set for the 3D scene (2D, or nothing to draw). */
const NO_TERRAIN_LINES: readonly TerrainLineSpec[] = [];

const TRAIL_REBUILD_MS = 1000;
const TRAIL_REBUILD_POINTS = 5;

/**
 * The empty marine-layer set used while marine is parked (see
 * `@core/features/flags`). Module-level so it keeps ONE identity — the style
 * memo below lists `marineLayers` in its dependency array, and a fresh `[]`
 * per render would rebuild the whole MapLibre style on every render.
 */
const NO_MARINE_LAYERS: readonly MarineLayerId[] = [];

/** MapLibre ViewState bounds ([w,s,e,n]) → the wind layer's bbox shape. */
function windBoundsOf(vs: ViewState): WindBbox {
  return { west: vs.bounds[0], south: vs.bounds[1], east: vs.bounds[2], north: vs.bounds[3] };
}

// Fallback bottom padding for the select-trail camera fit, used only before
// TrailInspectPanel has ever reported its real height via onLayout (see
// inspectPanelHeight below) — e.g. the very first trail selected in a
// session. Generous on purpose: a slightly larger pad is a smaller trail
// on-screen, never a trail hidden under the panel.
const INSPECT_PANEL_H_ESTIMATE = 300;
/**
 * Top-centre chips (marine notice, destination readout) sit under the
 * "Search places" pill: its 8 dp top margin + 48 dp height + an 8 dp gap.
 */
const TOP_CHIP_OFFSET = 8 + 48 + 8;

// Breathing room between the panel's top edge and the fitted trail.
const INSPECT_PANEL_PAD = 24;

// Where the coffee mascot's bubble sits (#476): ABOVE the whole bottom row
// (scale bar, credit caption and tip button, measured live so a wrapped
// credit, a bigger font or a toast never ends up under it), right-aligned with
// the button (the column's 16 dp margin), its tail pointing down at the mug's
// centre (16 + 48 / 2 from the edge).
const TIP_BUBBLE_RIGHT = 16;
const TIP_BUBBLE_GAP = 8;
const TIP_BUBBLE_TAIL_RIGHT = 48 / 2;

/**
 * Throttled `toLineFeature(points, segmentStarts)`. Between rebuilds the
 * previous feature object is returned unchanged, so the GeoJSON source keeps a
 * stable reference. A trailing timer commits the newest points shortly after
 * fixes stop arriving, so the drawn line never visibly lags the GPS. Segment
 * starts only ever change together with the points (a resume adds its
 * boundary with the first post-pause fix), so `points` alone drives rebuilds.
 */
function useThrottledLineFeature(
  points: readonly TrackPoint[],
  segmentStarts: readonly number[],
): TrailLineFeature | null {
  const [feature, setFeature] = useState<TrailLineFeature | null>(() =>
    toLineFeature(points, segmentStarts),
  );
  const builtAtRef = useRef(0);
  const builtCountRef = useRef(points.length);

  useEffect(() => {
    const build = () => {
      builtAtRef.current = Date.now();
      builtCountRef.current = points.length;
      setFeature(toLineFeature(points, segmentStarts));
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
  }, [points, segmentStarts]);

  return feature;
}

export function MapScreen() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  // True only between onDidFinishLoadingMap and the next onWillStartLoadingMap
  // (which also fires when a remounted <Map> starts loading, re-arming the
  // gate). Every mapRef.getViewState() must be gated on
  // this: called before the native view is initialized, MLRNMapView.getCenter
  // NPEs on the native thread — a process crash a JS .catch() cannot intercept
  // (the launch-race crash behind the 07-30 nightly and local blank screens).
  const [mapLoaded, setMapLoaded] = useState(false);
  // Pre-selection camera, captured just before the first selection-driven
  // camera fit (see the inspect-fit effect below) so the panel's or the
  // carousel's ✕ can glide back to it. Switching the selection from one trail
  // to another must NOT overwrite it. Tapping the map elsewhere to leave the
  // focus FORGETS it instead: the camera stays put (2.1.1).
  const selectionCamera = useSelectionCamera(cameraRef, mapRef);

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
  // Standalone waypoints (dropped from the "+" actions menu, no recording needed).
  const savedWaypoints = useLibraryStore((s) => s.waypoints);
  const addSavedWaypoint = useLibraryStore((s) => s.addWaypoint);
  const renameSavedWaypoint = useLibraryStore((s) => s.renameWaypoint);
  const updateSavedWaypoint = useLibraryStore((s) => s.updateWaypoint);
  const removeSavedWaypoint = useLibraryStore((s) => s.removeWaypoint);
  // Map-visibility modes: 'type' = everything (trails per activeTrackIds);
  // 'folders' = exactly the checked folders' maps, trails and waypoints (pure
  // selectors in @core/library/visibility). The persisted "PDF maps" master
  // switch sits over both for maps (#233): off, the overlay pipeline gets no
  // targets at all — nothing drawn, nothing rasterized, nothing on the cards.
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const activeTrackIds = useLibraryStore((s) => s.activeTrackIds);
  const showPdfOverlay = useSettingsStore((s) => s.showPdfOverlay);
  const pdfWhiteKey = useSettingsStore((s) => s.pdfWhiteKey);
  const shownMaps = useMemo(
    () => pdfOverlayMaps(showPdfOverlay, mapVisibilityMode, visibleFolderIds, maps),
    [showPdfOverlay, mapVisibilityMode, visibleFolderIds, maps],
  );
  const shownTrackIds = useMemo(
    () => visibleTrackIds(mapVisibilityMode, visibleFolderIds, tracks, activeTrackIds),
    [mapVisibilityMode, visibleFolderIds, tracks, activeTrackIds],
  );
  // `enabled` is passed as well as the (already empty) target list so a page
  // mid-render when the switch flips off is abandoned, not drawn late.
  const { overlays, error: overlayError } = usePdfOverlays(shownMaps, showPdfOverlay, pdfWhiteKey);
  // The trail-overlays master switch (map store): off, no trail or heat
  // geometry is drawn, so none is loaded or built either (#465).
  const showTrackOverlays = useMapStore((s) => s.showTrackOverlays);
  const drawnTrackIds = showTrackOverlays ? shownTrackIds : NO_IDS;
  const drawnTrackCount = useMemo(() => {
    const ids = new Set(tracks.map((t) => t.id));
    return drawnTrackIds.filter((id) => ids.has(id)).length;
  }, [tracks, drawnTrackIds]);
  // When the heatmap toggle is on, the heat layer + tap-carousel must source
  // EVERY track in the library, not just whatever the current visibility
  // mode/folder filters/activeTrackIds happen to show ("if heatmap is
  // selected, it shouldn't need the trace to be shown"). When it's off this
  // collapses to exactly the shown trails, and the heat grid isn't built.
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const heatOn = showTrackOverlays && showHeatmap;
  const allTrackIds = useMemo(
    () => (heatOn ? tracks.map((t) => t.id) : drawnTrackIds),
    [heatOn, tracks, drawnTrackIds],
  );
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
  const basemap = useMapStore((s) => s.basemap);
  const shownTrail = useLongTrailsStore((s) => s.shown);
  const [trailSheetHeight, setTrailSheetHeight] = useState(0);
  const theme = useTheme();
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  // Stable per basemap so the contour sources' memo can hold (see the hoisted
  // layer constants above). The vector Stone & Paper base gets the board's
  // ochre isolines. Offline-only draws it too: new `map` packs are vector
  // (older raster ones are flagged for re-download in Settings).
  const stoneBase = VECTOR_BASEMAP_ENABLED && basemap === 'map';
  // Contours on the vector map are served tiles, part of the style.
  const terrainContours = useSettingsStore((s) => s.terrainContours);
  // Heat ramp and line outlines follow the ground (#492): paper map, night
  // map, or satellite imagery (dark in both themes).
  const lineOutline = lineOutlineFor(basemap === 'satellite' ? 'satellite' : 'map', theme.dark);
  const heatLayerSet = HEAT_LAYERS[lineOutline];
  const contourLayerSet =
    basemap === 'satellite'
      ? CONTOUR_LAYERS.satellite
      : stoneBase
        ? theme.dark
          ? CONTOUR_LAYERS.stoneDark
          : CONTOUR_LAYERS.stoneLight
        : CONTOUR_LAYERS.plain;
  const offlineRegions = useOfflineStore((s) => s.regions);
  // 2D base style with shaded-relief hillshade for the outdoor/topo look.
  //
  // With "Locally downloaded only" on, the style also (a) caps the raster
  // source at the packs' top stored zoom so zooming past it overscales the
  // deepest downloaded tiles instead of going blank, and (b) masks everything
  // outside the downloaded regions with an opaque theme-matched fill (white in
  // light mode, the app background in dark mode) — downloaded areas show
  // through holes in the mask; trails/markers/location still draw on top.
  // Compact map chrome: chevron-rail unfold state (the "+" actions button
  // lives in the rail too, so it folds away with the rest of the controls).
  const [compactControlsOpen, setCompactControlsOpen] = useState(false);
  // Weather overlay (weather UX M1): the persisted GeoMet layer choice, the
  // transient play flag, and the scrubbable timeline that owns the drape's
  // valid time (throttled inside the hook). Network-only: while offline-only
  // is on the layer is dropped from the style entirely and the timeline hook
  // is parked, so the map stays byte-identical to a weatherless one.
  //
  // PARKED (2026-09, see `@core/features/flags`): while WEATHER_ENABLED is
  // false the persisted choice is READ BUT NOT USED — every weather surface
  // and every weather fetch below is derived from `weatherLayer`, so forcing
  // it to null here parks the whole feature at one point. The stored value is
  // deliberately left untouched: flip the flag and the user's layer comes
  // back exactly as they left it.
  const persistedWeatherLayer = useSettingsStore((s) => s.weatherLayer);
  const weatherLayer = WEATHER_ENABLED ? persistedWeatherLayer : null;
  // M2: which ECCC model the forecast drapes resolve against (persisted;
  // radar ignores it). The model sheet floats above the scrubber, toggled by
  // its chevron — plain dock state, never a Portal.
  const weatherModel = useSettingsStore((s) => s.weatherModel);
  const setSettings = useSettingsStore((s) => s.set);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // Wave B (worldwide weather): the camera's settled centre, and the model
  // the drape actually resolves to there — the user's selection inside its
  // domain, GDPS (global) outside it (HRDPS/RDPS are Canada-domain; see
  // `@core/weather/modelCoverage`). The persisted selection is never
  // touched: pan home and the chosen model comes back. Everything drape-
  // shaped below (tile URL, timeline, wind particles, scrubber caption)
  // rides the EFFECTIVE model so they can never disagree.
  const mapCenter = useMapStore((s) => s.mapCenter);
  const setMapCenter = useMapStore((s) => s.setMapCenter);
  const { model: effectiveModel, fallback: modelFallback } = resolveEffectiveModel(
    weatherModel,
    mapCenter,
  );
  // Changing the LAYER closes the sheet (a fresh layer starts from the
  // scrubber, like Windy); switching models inside the sheet keeps it open.
  useEffect(() => {
    const t = setTimeout(() => setModelSheetOpen(false), 0);
    return () => clearTimeout(t);
  }, [weatherLayer]);
  const weatherAnimating = useMapStore((s) => s.weatherAnimating);
  const toggleWeatherAnimation = useMapStore((s) => s.toggleWeatherAnimation);
  // Playback pacing + the crossfade's "is the staged frame drawn yet" gate.
  // Refs, not state: `onDidFinishRenderingFrameFully` fires tens of times a
  // second and the timeline hook sits UPSTREAM of the crossfade, so state
  // here would mean a render storm and a dependency cycle (perf fix
  // 2026-08-10).
  const weatherStagingRef = useRef(false);
  const renderedFramesRef = useRef(0);
  // The crossfade's mounted slot keys, read back by the frame source (which
  // sits UPSTREAM of the crossfade) so its bounded map never drops a frame a
  // slot is still drawing. Same ref-breaks-the-cycle trick as the pacing.
  const weatherSlotsRef = useRef<readonly (string | null)[]>([null, null]);
  // Settled viewport bounds, written on every camera settle (and seeded once
  // the map loads). The marine chart re-anchors off this — unlike the wind
  // field's own settled bounds it is NOT gated on the wind overlay — and so
  // does the weather drape, which is why both live this high up.
  const [settledBounds, setSettledBounds] = useState<WindBbox | null>(null);
  const pdfWindow = useWindowDimensions();
  // Settled camera zoom + centre latitude, the two inputs the scale bar needs
  // (a Web-Mercator pixel is ~8× less ground at 83°N than at the equator).
  // SETTLE-driven on purpose: `onRegionIsChanging` fires at gesture rate and
  // would re-render this whole tree per frame — see ScaleBar's own note. The
  // setter collapses no-op updates so a pan along a parallel costs nothing.
  const showScaleBar = useSettingsStore((s) => s.showScaleBar);
  /** Shaded-relief hillshade under `map` — platform-defaulted, #230. */
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  /** Its strength and the summits' density — the Topology menu's #461 rows. */
  const hillshadeStrength = useSettingsStore((s) => s.hillshadeStrength);
  const peakDensity = useSettingsStore((s) => s.peakDensity);
  /** "Parks & protected areas": boundaries and names on the vector layers. */
  const showParks = useSettingsStore((s) => s.showParks);
  /** Settings → Extensions → Geodetic points: installed, and its overlay switch on. */
  const geodeticInstalled = useSettingsStore((s) => s.geodeticInstalledAt > 0);
  const showGeodetic = useSettingsStore((s) => s.showGeodetic);
  const geodeticTiles = geodeticInstalled && showGeodetic ? geodeticTilesUrl() : null;
  const geodeticFilter = useSettingsStore((s) => s.geodeticFilter);
  const geodeticFilters = useMemo(() => buildGeodeticFilters(geodeticFilter), [geodeticFilter]);
  /** Overlays → Tide stations (`@core/map/tideStyle`). */
  const showTideStations = useSettingsStore((s) => s.showTideStations);
  const tideTiles = showTideStations ? tideTilesUrl() : null;
  /** Canadian stations: fetched live from CHS by the phone and kept on it (never our tiles). */
  const chsStations = useChsStations(tideTiles !== null, offlineOnly);
  /** How much that shading deepens when the map is tilted — "3D relief", #480. */
  const tiltRelief = useSettingsStore((s) => s.tiltRelief);
  const betaTerrain3d = useSettingsStore((s) => s.betaTerrain3d);
  /**
   * Non-null while the map maker is open: the print style whose raster the
   * live map must render so the framed preview matches the sheet (#349).
   * Declared here, with the other style inputs, because the style memo below
   * consumes it.
   */
  const [editorStyle, setEditorStyle] = useState<PrintStyleId | null>(null);
  const [scaleAt, setScaleAt] = useState<{ zoom: number; latitude: number } | null>(null);
  const updateScaleAt = useCallback((zoom: number, latitude: number) => {
    setScaleAt((prev) =>
      prev !== null &&
      Math.abs(prev.zoom - zoom) < 0.01 &&
      Math.abs(prev.latitude - latitude) < 0.01
        ? prev
        : { zoom, latitude },
    );
  }, []);
  // What the trail lines and heatmap are built for (#494): the settled
  // viewport plus a margin, sticky across small moves (see useCullRegion).
  const cullRegion = useCullRegion(settledBounds, scaleAt?.zoom ?? null);
  const { inspectId, inspectTrack, inspectPoints, markerAt, setMarkerAt, inspect } =
    useTrailInspection(tracks);
  // Which trail is "selected": a tap-selected heat spot (the carousel) wins,
  // otherwise whichever trail is open in the inspect panel. Its geometry is
  // loaded even when its trace is hidden (the heatmap itself no longer loads
  // the library's, #500), so its highlight can be drawn.
  const focusedTrackId = heatSelection
    ? (heatSelection.trackIds[heatSelection.focusedIdx] ?? null)
    : inspectId;
  const trackHeat = useTrackHeat(
    tracks,
    drawnTrackIds,
    allTrackIds,
    heatOn,
    cullRegion,
    focusedTrackId,
  );
  // The big sources, serialized once per data change (#465).
  // <GeoJSONSource> stringifies an object `data` on EVERY render of the source
  // — and a selection flips the lines layer's filter, which re-renders it — so
  // a 400-trail source used to be re-serialized and re-parsed natively on
  // every tap. A string that keeps its identity is passed through untouched.
  const linesJson = useGeoJsonString(trackHeat.lines);
  const heatLinesJson = useGeoJsonString(trackHeat.heatLines);
  const heatGlowJson = useGeoJsonString(trackHeat.heatGlow);
  // The MapView's laid-out size as low-rate STATE: the wind camera seed must
  // not run before the map has laid out (see its comment), and the weather
  // drape sizes its GetMap from it. onLayout fires only on mount/rotation,
  // so a re-render here costs nothing.
  const [windLayout, setWindLayout] = useState({ width: 0, height: 0 });
  const weatherTl = useWeatherTimeline(
    offlineOnly ? null : weatherLayer,
    effectiveModel,
    weatherAnimating,
    weatherStagingRef,
  );
  // Marine reference layers (marine M3): NONNA bathymetry / seamarks, same
  // network-only treatment as the weather. Any active layer also pins
  // the mandatory "Not for navigation" chip below.
  //
  // PARKED (2026-09, see `@core/features/flags`): same treatment as weather —
  // the persisted array is read but swapped for a stable empty one while
  // MARINE_ENABLED is false, which switches off the chart drape, the
  // soundings, the depth legend, the disclaimer chip, the pack banner and
  // every marine fetch in one place. NO_MARINE_LAYERS is module-level so the
  // style memo's dependency identity stays stable across renders.
  const persistedMarineLayers = useSettingsStore((s) => s.marineLayers);
  const marineLayers = MARINE_ENABLED ? persistedMarineLayers : NO_MARINE_LAYERS;
  // Offline marine packs (wave D §D4): a downloaded reach renders and answers
  // tap-for-depth with the radio off, so chart mode survives offline-only
  // mode as soon as ANY pack exists — the one place `offlineOnly` doesn't
  // simply switch a network layer off.
  const installedPacks = useMarinePackStore((s) => s.installed);
  const packTotalBytes = useMarinePackStore((s) => s.totalBytes);
  const packProgress = useMarinePackStore((s) => s.progress);
  const marineActive = marineLayers.length > 0 && (!offlineOnly || installedPacks.size > 0);
  // Long-pressed point whose forecast/tides card is open (shown while a
  // weather or marine layer is active).
  const [forecastAt, setForecastAt] = useState<LatLng | null>(null);
  // Drop-a-pin destination (#97): a long-press on the bare map (or the "Set
  // destination" button in the coordinates dialog) plants ONE pin, and the
  // top-centre chip reads out live distance + bearing to it from the current
  // fix. Session state on purpose — a destination is a "right now" thing, not
  // a library object; saving a place is what waypoints are for.
  //
  // This is emphatically NOT route following: no legs, no turns, no ETA, no
  // snapping to a trail. That is issue #95.
  const [destination, setDestination] = useState<LatLng | null>(null);
  // True while the PERSON pans or zooms. Only the mascot BUBBLE waits on it
  // (none pops mid-gesture or for 5 s after, #476); the mug's loop ignores
  // map interaction entirely (owner). Driven by createGesturePause: taps
  // never count, a settle or a tap ends it, and it clears itself after 3 s
  // even when iOS drops the matching "did change".
  const [cameraMoving, setCameraMoving] = useState(false);
  const [gesturePause] = useState(() => createGesturePause(setCameraMoving));
  useEffect(() => () => gesturePause.dispose(), [gesturePause]);
  // A rail sheet (map type, overlays, "+" actions) is open: no mascot bubble (#476).
  const [railMenuOpen, setRailMenuOpen] = useState(false);
  // The bottom column's height and the row's top inside it, for the bubble.
  const [bottomColumnH, setBottomColumnH] = useState<number | null>(null);
  const [bottomRowY, setBottomRowY] = useState<number | null>(null);
  // The ⓘ credits sheet (2.1.1): what the map is drawing, with its © lines.
  const [creditsOpen, setCreditsOpen] = useState(false);
  // Coordinate readout/entry dialog (#97), opened from the map-actions sheet.
  // The centre is captured WHEN IT OPENS (an exact getViewState read) rather
  // than tracked per settle — nothing else needs a metre-accurate centre, and
  // the scale bar's own settled state is deliberately coarse.
  const [goToOpen, setGoToOpen] = useState(false);
  const [goToCenter, setGoToCenter] = useState<LatLng | null>(null);
  /**
   * #232 — when the chip's action row last TOOK a touch. On iOS MapLibre's
   * tap recognizer fires for a tap the row already claimed as a responder,
   * and reports the MARKER's own anchor as the tap point — so the chip
   * hit-test below would read it as "tapped the chip" and dismiss the chip
   * out from under the action. Set at touch-start, i.e. before that press
   * arrives, so the window only ever swallows the tap that caused it.
   */
  const chipTouchAtRef = useRef(0);
  // #232 — the tapped point the coordinates dialog opens prefilled with; null
  // for the "+" sheet's secondary entry, which opens on an empty box.
  const [goToSeed, setGoToSeed] = useState<LatLng | null>(null);
  // Place search (#496): the sheet the pill opens, the map centre read when
  // it opened (the index's bias without a GPS fix), and the result just
  // flown to — highlighted until the next tap on the map.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchBias, setSearchBias] = useState<LatLng | null>(null);
  const [searchHit, setSearchHit] = useState<Place | null>(null);
  const pushPlaceRecent = usePlaceRecentsStore((s) => s.push);
  // Tap-anywhere point readout (wave A item 7, generalized by marine wave D
  // §D1/D-5): a bare tap drops/moves ONE chip here whatever the active
  // layers — coordinates on the plain map, the weather value with a weather
  // layer, the surveyed depth in marine mode, both lines stacked when both
  // are on. Tapping the chip itself dismisses it (and copies the coordinates
  // in the bare-map case) — hit-tested in onMapPress below.
  const [pointAt, setPointAt] = useState<LatLng | null>(null);
  // Frame-swap crossfade (wave A item 3): the throttled TIME's tile URL runs
  // through a two-slot A/B stage-then-flip so the outgoing frame stays on
  // screen while the incoming one prefetches at opacity 0 — the drape never
  // blanks between frames during playback/scrub. Pure slot machine in
  // @core/weather/weatherCrossfade; both phases rebuild the style memo below.
  // The drape's frames (perf work 2026-08-11): ONE viewport GetMap per frame,
  // downloaded to disk and warmed a few frames ahead, instead of the ~15 WMS
  // tile requests the `{bbox-epsg-3857}` template used to make per frame.
  // `frameKey` only advances to a frame whose PNG is already local, so the
  // crossfade below stages something that can be drawn immediately.
  const weatherDrape = useWeatherDrape(
    weatherLayer !== null && !offlineOnly
      ? resolveModelWmsLayer(weatherLayer, effectiveModel)
      : null,
    weatherTl.timeline,
    weatherTl.drapeIdx,
    settledBounds,
    windLayout,
    weatherAnimating,
    weatherSlotsRef,
  );
  const weatherFade = useWeatherCrossfade(weatherDrape.frameKey, renderedFramesRef);
  useEffect(() => {
    // Playback holds its beat while a frame is staging OR still downloading,
    // so it can never run ahead of what the drape can show.
    weatherStagingRef.current = weatherFade.pendingSlot !== null || weatherDrape.fetching;
  }, [weatherFade.pendingSlot, weatherDrape.fetching]);
  useEffect(() => {
    // Which frames are actually mounted, fed back UPSTREAM so the drape's
    // bounded frame map can never evict one out from under a live slot.
    weatherSlotsRef.current = weatherFade.slots;
  }, [weatherFade.slots]);
  // The reference labels ride weather/marine (OpenFreeMap; not offline). The
  // flag-gated vector base map reads our own tile host, offline from packs.
  // The map maker swaps in the raster it prints (#349), so the live map
  // must drop the vector base while the editor is open.
  const referenceOverlay = weatherLayer !== null || marineLayers.length > 0;
  const vectorBasemap = stoneBase && editorStyle === null;
  // "Labels on satellite" (#484): our roads, trails and names over the
  // imagery, from the same vector host as the map (and, offline, from any
  // downloaded Map pack of the area — packs share tiles by URL).
  const satelliteLabels = useSettingsStore((s) => s.satelliteLabels);
  const satelliteImagery = useSettingsStore((s) => s.satelliteImagery);
  const imageryLabels =
    VECTOR_BASEMAP_ENABLED && basemap === 'satellite' && satelliteLabels && editorStyle === null;
  // Contours on satellite (#492): the Map base's served contour tiles, drawn
  // in the style under the roads, names and PDF maps — exactly where the map
  // draws them — instead of the on-device contours, which mounted ABOVE the
  // PDF maps. Independent of the labels toggle.
  const imageryContours =
    VECTOR_BASEMAP_ENABLED && basemap === 'satellite' && terrainContours && editorStyle === null;
  const overlayTiles = useOverlayLabelTiles(referenceOverlay && !offlineOnly);
  // Tab screens stay mounted, so background work (the terrain pipeline, the
  // marine chart fetch) needs a focus gate — declared here because the style
  // memo below already depends on it through the marine chart.
  const [screenFocused, setScreenFocused] = useState(true);
  // Re-arm the getViewState gate whenever <Map> itself is NOT mounted
  // (before the persisted camera seed). This replaces the old
  // onWillStartLoadingMap reset, which also fired on every style reload —
  // see the handler's note on the reload storm that caused.
  const mapMounted = settingsHydrated;
  useEffect(() => {
    if (mapMounted) return;
    const t = setTimeout(() => setMapLoaded(false), 0);
    return () => clearTimeout(t);
  }, [mapMounted]);
  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      return () => setScreenFocused(false);
    }, []),
  );
  // Marine chart drape (wave D §D2): the client-rendered ENC depth bands +
  // contours + spot soundings for the settled region, replacing the CHS
  // server's blocky pre-coloured mosaic. Silent on every failure — `fallback`
  // simply re-enables the legacy WMS drape below.
  const units = useSettingsStore((s) => s.units);
  const marineChart = useMarineChart(
    marineActive && screenFocused && mapLoaded,
    settledBounds,
    units === 'imperial',
    installedPacks,
    installedPacks.size + packTotalBytes,
  );
  // Display mode in effect (decision 4): drives the night raster and veil.
  const displayCondition = useDisplayCondition();
  const style = useMemo(() => {
    const options = {
      // Night red (decision 4): greyscale, dimmed raster under the red veil.
      night: displayCondition === 'night',
      // Marine drapes are network-only: hidden while offline-only.
      marineLayers: offlineOnly ? [] : marineLayers,
      // Labels + coastlines readable ABOVE the colour drapes (wave B): the
      // reference overlay rides whenever a weather OR marine layer is on and
      // the OpenFreeMap TileJSON resolved (silent-degrade otherwise).
      ...(vectorBasemap
        ? {
            vectorBasemap: {
              ...vectorBasemapOption(theme.dark, terrainContours),
              peakDensity,
              protectedAreas: showParks,
            },
          }
        : {}),
      ...(imageryLabels
        ? {
            imageryLabels: {
              ...vectorBasemapOption(theme.dark, false),
              peakDensity,
              protectedAreas: showParks,
            },
          }
        : {}),
      ...(imageryContours ? { imageryContours: imageryContoursOption() } : {}),
      hillshadeStrength,
      tiltRelief,
      // #495: the imagery's brightening paint. The map maker's frame shows
      // the raw tiles, because that is what its sheet prints.
      imageryLook: editorStyle === null ? satelliteImagery : ('original' as const),
      ...(overlayTiles !== null && referenceOverlay
        ? {
            overlayLabels: {
              dark: theme.dark,
              tiles: overlayTiles,
              // Major-road reference pass: weather only. Marine chart mode
              // dims land on purpose so the water reads as the content.
              roads: weatherLayer !== null,
            },
          }
        : {}),
      // Marine chart mode (wave D): the whole map restyles as a nautical
      // chart — tan land, flat chart-blue water, the client-rendered depth
      // bands + contours + spot soundings — with the legacy WMS drape kept
      // as the silent fallback while the client pipeline has nothing.
      ...(marineActive
        ? {
            // The client drape + soundings are NOT in here: they mount as
            // MapView children so a re-anchored chart never reloads the
            // whole native style (see MarineChartLayers).
            marineChart: {
              wmsFallback: marineChart.fallback && !offlineOnly,
              // Which imagery the coverage ladder fell back to, if any
              // (GEBCO worldwide / NOAA ENC in US waters); null keeps the
              // legacy CHS WMS pair, which is the right answer in Canada.
              rasterUrl: offlineOnly ? null : marineChart.rasterUrl,
            },
          }
        : {}),
      ...(weatherLayer !== null && !offlineOnly
        ? {
            // The frames themselves mount as MapView children
            // (WeatherDrapeLayers) — a frame URL in this object would reload
            // the entire native style twice per playback tick. The drape's
            // opacity travels with them, at that call site.
            //
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
      // The editor's base raster is an ONLINE Esri print source, so the
      // offline packs' top stored zoom says nothing about it — applying that
      // cap here would overscale the print source for anyone who owns a pack
      // (#349). The source's own NATIVE_MAX_ZOOM still applies, from the
      // basemap argument below.
      ...(offlineOnly && editorStyle === null
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
      // Geodetic points (Settings → Extensions): on every base map, not in
      // the map maker (its frame shows what the printed sheet will carry).
      ...(geodeticTiles !== null && editorStyle === null
        ? {
            geodetic: {
              tiles: geodeticTiles,
              dark: theme.dark,
              filters: geodeticFilters,
              ...geodeticGlyphs(),
            },
          }
        : {}),
      ...(tideTiles !== null && editorStyle === null
        ? { tides: { tiles: tideTiles, dark: theme.dark, chs: chsStations, ...geodeticGlyphs() } }
        : {}),
    };
    // While the map maker is open the base raster becomes the source the
    // composer stitches, so the frame and the sheet cannot disagree (#349).
    const editor = editorStyle === null ? null : printStyleById(editorStyle);
    return buildOsmStyle(
      editor ? editor.tileUrl : tileUrl,
      editor ? editor.drape : basemap,
      showHillshade,
      // Under-declare the tile size while the editor is open so the sheet gets
      // four times the pixels on a retina screen (#349, owner: "load more
      // pixels"). Scoped to the editor: it is also four times the tiles.
      editor ? { ...options, rasterTileSize: EDITOR_RASTER_TILE_SIZE } : options,
    );
  }, [
    terrainContours,
    tileUrl,
    editorStyle,
    basemap,
    showHillshade,
    hillshadeStrength,
    peakDensity,
    showParks,
    tiltRelief,
    offlineOnly,
    offlineRegions,
    theme.dark,
    theme.colors.background,
    displayCondition,
    marineLayers,
    marineActive,
    // Only the FALLBACK shape of the chart state restyles the map; the drape
    // and the soundings are live children, so a new render must not rebuild
    // (and therefore reload) the style.
    marineChart.fallback,
    marineChart.rasterUrl,
    weatherLayer,
    overlayTiles,
    referenceOverlay,
    vectorBasemap,
    imageryLabels,
    imageryContours,
    satelliteImagery,
    geodeticTiles,
    geodeticFilters,
    tideTiles,
    chsStations,
  ]);

  // Native 3D terrain (docs/plans/native-terrain.md): with "3D relief" on and
  // a binary that ships the module, tilting past ~25° grows real relief out of
  // the flat map, drawn natively inside MapLibre (no JS per frame). It
  // replaces the tilted-map hillshade pass below while attached.
  const terrainHostRef = useRef<View | null>(null);
  const terrainTagRef = useRef<number | null>(null);
  const terrainQa = useTerrainQa(cameraRef, terrainTagRef);
  const terrain3d = useNativeTerrain({
    hostRef: terrainHostRef,
    mapLoaded,
    relief: tiltRelief,
    // Beta (Settings → Beta features): off = the native layer is never
    // attached and the map tilts to 60° with its 2D relief pass, as before.
    allowed: betaTerrain3d && editorStyle === null && !terrainQa.disabled,
    basemap: basemap === 'satellite' ? 'satellite' : 'map',
    dark: theme.dark,
    networkAllowed: !offlineOnly,
    probe: terrainQa.probe,
    debugFlags: terrainQa.debugFlags,
    // The map draws its contours always; satellite follows its contour setting.
    contours: basemap === 'satellite' ? terrainContours : true,
    // Only while the beta is on: no drape JSON is built otherwise.
    style: betaTerrain3d ? (style as unknown as DrapeStyleInput) : undefined,
    drapeDropLayerIds: TERRAIN_DRAPE_DROP_IDS,
    hillshadeLayerId: HILLSHADE_2D_LAYER_ID,
    contourLayerIds: TERRAIN_DRAPE_CONTOUR_IDS,
    // Pins stay clear of the search/status band and the scale-bar row.
    labelInsets: { top: insets.top + TERRAIN_PIN_TOP_CHROME, bottom: TERRAIN_PIN_BOTTOM_CHROME },
    demSourceId: HILLSHADE_DEM_SOURCE_ID,
    // The satellite basemap's raster source ('osm' in buildOsmStyle).
    imagerySourceId: basemap === 'satellite' ? 'osm' : undefined,
  });
  useEffect(() => {
    terrainTagRef.current = terrain3d.viewTag;
  }, [terrain3d.viewTag]);

  // The tilted-map relief pass (#480): the style carries it hidden whenever
  // it draws the shading and the setting is on; the hook switches it on from
  // the settled pitch (off while the native 3D terrain draws real relief).
  const tilt = useTiltRelief(
    style,
    basemap === 'satellite' && editorStyle === null,
    terrain3d.active,
  );

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
    stats,
    points,
    segmentStarts,
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

  // Recording panel (revamp decision 3): its measured height lifts the map's
  // bottom chrome above it, and glove lock shields everything else.
  const [panelHeight, setPanelHeight] = useState(0);
  const [gloveLockRequested, setGloveLocked] = useState(false);
  const lastAccuracyM = useRecorderStore((s) => s.lastAccuracyM);

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
  } = useOfflineDownload({ mapRef, cameraRef, showSnack, mapLoaded });
  // The recording panel yields the bottom edge to the region-select overlay.
  const recordingPanelUp = status !== 'idle' && !selecting;
  // Glove lock only means anything while the panel is up; stopping clears it.
  const gloveLocked = gloveLockRequested && recordingPanelUp;

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

  const { fitOverlayBounds, flyToPlace, flyToPoint, resetNorth, snapToNorth, zoomToLocateLevel } =
    useCameraControls({
      cameraRef,
      mapRef,
      overlays,
    });
  // Settled map bearing → the compass badge's red north needle, plus the
  // snap-back detent that undoes the rotation a zoom pinch leaks in (#248).
  const { mapBearing, onSettleBearing } = useMapBearing({ snapToNorth });
  // Use the laid-out map frame, not the window (which may include navigation
  // chrome), and its settled bearing to size rotated PDF detail in pixels.
  const pdfPixelRatio = Math.min(pdfWindow.scale, 3);
  const pdfDetails = usePdfDetails(
    shownMaps,
    overlays,
    showPdfOverlay ? settledBounds : null,
    windLayout.width * pdfPixelRatio,
    { heightPx: windLayout.height * pdfPixelRatio, bearing: mapBearing },
    isFocused,
  );
  // Live distance + bearing to the destination pin (#97). Recomputed on every
  // fix, which is exactly what "live" means here — the maths is two trig
  // calls in `@core/geo/destination`, far cheaper than the fix that triggers it.
  const destReadout = useMemo(
    () => destinationReadout(location, destination, units),
    [location, destination, units],
  );
  // Same two numbers for the tapped point while its chip is up (#232).
  const pointReadout = useMemo(
    () => destinationReadout(location, pointAt, units),
    [location, pointAt, units],
  );

  // Open the coordinates dialog with an exact map centre. getViewState is
  // gated on `mapLoaded`: called before the native view is initialised it
  // NPEs on the native thread, a process crash no JS catch can intercept.
  const openGoToCoordinates = useCallback(
    async (seed: LatLng | null = null) => {
      let center: LatLng | null = null;
      if (mapLoaded) {
        try {
          const vs = await mapRef.current?.getViewState();
          if (vs) center = { latitude: vs.center[1], longitude: vs.center[0] };
        } catch {
          // Map mid-teardown — open with the readout half empty rather than not
          // at all; the entry half still works.
        }
      }
      setGoToCenter(center);
      setGoToSeed(seed);
      setGoToOpen(true);
    },
    [mapLoaded],
  );

  // Open the place search (#496). Same mapLoaded gate as above for the
  // centre read; without it the search simply has no fallback bias.
  const openPlaceSearch = useCallback(async () => {
    let center: LatLng | null = null;
    if (mapLoaded) {
      try {
        const vs = await mapRef.current?.getViewState();
        if (vs) center = { latitude: vs.center[1], longitude: vs.center[0] };
      } catch {
        // Map mid-teardown: search without a bias.
      }
    }
    setSearchBias(center);
    setSearchOpen(true);
  }, [mapLoaded]);

  // A result was picked: remember it, fly there, and mark the spot.
  const onPickPlace = useCallback(
    (place: Place) => {
      setSearchOpen(false);
      pushPlaceRecent(place);
      setPointAt(null);
      setSearchHit(place);
      flyToPlace(cameraTargetFor(place));
    },
    // flyToPlace closes over refs only (see aimAt below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pushPlaceRecent],
  );
  const closePlaceSearch = useCallback(() => setSearchOpen(false), []);

  // Aim at a coordinate: plant the pin, point the camera at it, and say so.
  const aimAt = useCallback(
    (at: LatLng) => {
      setDestination(at);
      flyToPoint(at);
      showSnack(`Destination set — ${formatLatLng(at.latitude, at.longitude)}`);
    },
    // flyToPoint is recreated every render (it closes over refs only), so it
    // is deliberately not a dependency — listing it would defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showSnack],
  );

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
  const [regionVersion, setRegionVersion] = useState(0);
  // `screenFocused` (declared above with the marine chart) is the focus gate:
  // without it the overlay pipeline kept fetching DEM tiles and contouring in
  // the background after switching to Library/Settings.
  const terrainOverlays2d = useTerrainOverlays2D({
    mapRef,
    boundsVersion: regionVersion,
    // offlineOnly also disables these: DEM-derived layers drape over the
    // downloaded-only mask's blank void, which reads as garbage.
    // mapLoaded: the pipeline opens with getViewState — see the state's
    // declaration comment (native crash if called before the map loads).
    active: settingsHydrated && screenFocused && !offlineOnly && mapLoaded,
    contoursFromTiles: vectorBasemap || imageryContours,
  });

  // Wind particle overlay (weather M3): Windy-style streaks over the wind
  // gradient. Everything hangs off one gate — the Wind layer active, 2D,
  // online, the windParticles kill-switch, the screen focused and the map
  // loaded (getViewState below NPEs pre-load). WindParticleLayer adds the
  // AppState background gate itself; unmounting is what stops the GL loop.
  const windParticles = useSettingsStore((s) => s.windParticles);
  const windEnabled =
    weatherLayer === 'wind' && !offlineOnly && windParticles && screenFocused && mapLoaded;
  // Camera state at gesture rate lives in a REF (the GL loop reads it per
  // frame) — pushing 30–60 Hz onRegionIsChanging payloads through setState
  // would re-render the whole screen per frame. React state only carries the
  // low-rate bits: "a gesture is in progress" and the settled bounds.
  const windViewRef = useRef<WindViewState | null>(null);
  const windSizeRef = useRef({ width: 0, height: 0 });
  // Contour tiles the map failed to load (a 503 from the tile Worker) stay
  // holes until the user pans away and back: MapLibre does not ask again.
  // Once the camera settles this looks for them and gets them reloaded —
  // bounded, online only, and only while the served contours are on screen.
  const onContourSettled = useContourRecovery({
    mapRef,
    enabled:
      CONTOUR_RECOVERY_ENABLED &&
      mapLoaded &&
      screenFocused &&
      !offlineOnly &&
      ((vectorBasemap && terrainContours) || imageryContours),
    tilesUrl: vectorContoursUrl(),
    sourceId: VECTOR_CONTOURS_SOURCE,
    minzoom: CONTOUR_SOURCE_MINZOOM,
    maxzoom: CONTOUR_SOURCE_MAXZOOM,
    layerIds: CONTOUR_LINE_LAYER_IDS,
    viewSize: () => windSizeRef.current,
  });
  const [windInteracting, setWindInteracting] = useState(false);
  const [windSettledBounds, setWindSettledBounds] = useState<WindBbox | null>(null);
  const windSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(windSettleTimer.current ?? undefined), []);
  const writeWindView = useCallback((vs: ViewState) => {
    windViewRef.current = {
      centerLng: vs.center[0],
      centerLat: vs.center[1],
      zoom: vs.zoom,
      bearing: vs.bearing,
      pitch: vs.pitch,
      width: windSizeRef.current.width,
      height: windSizeRef.current.height,
    };
  }, []);
  // Streamed during gestures/animations: track the camera in the ref; for
  // USER gestures also fade the particles out and arm the ~400 ms settle
  // (Windy's own mobile mitigation — re-seed once the camera rests).
  const onWindRegionIsChanging = useCallback(
    (e: { nativeEvent: ViewStateChangeEvent }) => {
      const ev = e.nativeEvent;
      writeWindView(ev);
      if (!ev.userInteraction) return;
      setWindInteracting(true);
      clearTimeout(windSettleTimer.current ?? undefined);
      windSettleTimer.current = setTimeout(() => {
        setWindInteracting(false);
        setWindSettledBounds(windBoundsOf(ev));
      }, GESTURE_SETTLE_MS);
    },
    [writeWindView],
  );
  // Settled camera (also fires for programmatic moves): re-anchor input.
  const onWindRegionDidChange = useCallback(
    (e: { nativeEvent: ViewStateChangeEvent }) => {
      const ev = e.nativeEvent;
      writeWindView(ev);
      clearTimeout(windSettleTimer.current ?? undefined);
      setWindInteracting(false);
      setWindSettledBounds(windBoundsOf(ev));
    },
    [writeWindView],
  );
  // Seed the camera ref/bounds when the overlay activates mid-session (the
  // region callbacks only fire on movement).
  //
  // Gated on a KNOWN layout size: getViewState can resolve before the map's
  // first onLayout, and a camera state carrying width/height 0 makes the
  // particle projection scale 2·worldSize (see fieldClipMatrix), which maps
  // every particle far outside clip space. The overlay then renders NOTHING
  // until the user happens to pan — the M3 "no particles on a fresh launch"
  // report. Waiting for the layout makes the seed deterministic.
  useEffect(() => {
    if (!windEnabled || windLayout.width === 0 || windViewRef.current !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const vs = await mapRef.current?.getViewState();
        if (vs === undefined || cancelled) return;
        writeWindView(vs);
        setWindSettledBounds(windBoundsOf(vs));
      } catch {
        // map mid-teardown — the first region event will seed instead.
      }
    })();
    return () => {
      cancelled = true;
    };
    // windLayout is load-bearing: the wind fix re-stamps the camera on first
    // layout, so a 0x0 viewport can't be seeded (see fix/wind-particles).
  }, [windEnabled, windLayout, writeWindView]);
  // Seed the settled centre + bounds once the map loads (wave B / wave D):
  // the region callback only fires on movement, so without this a user who
  // never pans keeps a null centre — and the model fallback/radar hint (and
  // the marine chart's first render) would never resolve.
  useEffect(() => {
    if (!mapLoaded || (mapCenter !== null && settledBounds !== null)) return;
    let cancelled = false;
    void (async () => {
      try {
        const vs = await mapRef.current?.getViewState();
        if (vs === undefined || cancelled) return;
        setMapCenter({ latitude: vs.center[1], longitude: vs.center[0] });
        setSettledBounds(windBoundsOf(vs));
        onSettleBearing(vs.bearing);
      } catch {
        // map mid-teardown — the first region settle seeds instead.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapLoaded, mapCenter, settledBounds, setMapCenter, onSettleBearing]);
  useEffect(() => {
    if (terrainOverlays2d.error) showOverlaySnack(`Terrain overlay: ${terrainOverlays2d.error}`);
  }, [terrainOverlays2d.error, showOverlaySnack]);

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
    // pre-selection view held for the ✕ glide-back (see
    // useSelectionCamera). Gated on mapLoaded — see its declaration
    // comment (ungated getViewState NPEs on the native thread).
    selectionCamera.fitAfterCapture(fit, mapLoaded);
    // `setFollowUser` is a stable setter wrapper; `insets.top` is effectively
    // constant per device/orientation. `inspectPanelHeight` IS a real dep:
    // when the very first-ever panel layout lands after this effect already
    // fit with the estimate, this reruns to re-fit with the real padding —
    // safe because useSelectionCamera only captures once per
    // selection "session", so the re-fit never re-captures the (now
    // already-moved) view as the restore target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectId, inspectPoints, inspectTrack, inspectPanelHeight]);

  // Closing the inspect panel or the carousel (✕) leaves the camera where it
  // is, like a tap elsewhere on the map (owner, 2.1.1): it only forgets the
  // pre-selection snapshot. useSelectionCamera.restore() stays for a future
  // "back to where I was" control.
  const releaseCameraOnDeselect = selectionCamera.forget;

  // Item 5: when the heat-spot carousel OPENS, zoom the camera OUT to fit the
  // union of every trail it's showing (not just the focused one) — capturing
  // the pre-open camera first via the SAME useSelectionCamera snapshot the
  // inspect-panel fit above uses, so the carousel's own onClose (which
  // calls releaseCameraOnDeselect) releases it with no further wiring. Keyed on heatSelection?.trackIds's REFERENCE — that array is
  // reused as-is by onFocus (`{...cur, focusedIdx}`), so this only fires once
  // per carousel "open", not on every focused-card swipe.
  useEffect(() => {
    if (!heatSelection) return;
    // One pass over the library, not a `tracks.find` per carousel trail (#465).
    const wanted = new Set(heatSelection.trackIds);
    const boxes: BoundingBox[] = [];
    for (const t of tracks) if (wanted.has(t.id) && t.stats.bbox) boxes.push(t.stats.bbox);
    const union = unionBoundingBoxes(boxes);
    if (!union) return;
    setFollowUser(false);
    // Border-to-border on purpose (owner feedback 2026-08-06: the 25% bbox
    // inflation + deck-clearing margins landed way too zoomed out): fit the
    // union bbox itself, with just enough pixel padding that the trail's
    // line width and end markers aren't clipped by the very edge — the
    // carousel deck overlapping a corner of the fit is accepted. The padding
    // lives in @core/geo/cameraFit, where `cameraFit.test.ts` pins what it
    // frames: on a portrait phone this fit is WIDTH-limited, so the union
    // spans ~92% of the screen width and the vertical padding never reaches
    // the zoom at all (padding the top "to clear the deck" is a no-op, not a
    // fix — see that test before tuning anything here).
    const bounds = toLngLatBounds(union);
    const padding = carouselFitPadding(insets.top);
    const fit = () => cameraRef.current?.fitBounds(bounds, { duration: 600, padding });
    selectionCamera.fitAfterCapture(fit, mapLoaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatSelection?.trackIds]);

  // "Record track" intercepts here: the category sheet opens first, and only
  // its Start button actually begins the recording (owner ask: pick an
  // activity category BEFORE recording starts).
  const [pickingCategory, setPickingCategory] = useState(false);
  // The empty Library's "Record a trail" opens the same start sheet.
  const recordRequested = useMapStore((s) => s.recordRequested);
  const setRecordRequested = useMapStore((s) => s.setRecordRequested);

  // --- Map maker (1.4.0): region box → options sheet → compose → Library ---
  // One session at a time; a cancelled/superseded run can't reset the UI (#309).
  const { makeMapState, setMakeMapState, startMakeMap, cancelMakeMap } = useMakeMapSession({
    showSnack,
  });

  // --- Map maker editor (#349) ---------------------------------------------
  // While the editor is open the live map becomes the preview, so it has to
  // render the tile source the composer will actually stitch — otherwise the
  // frame shows OSM and the sheet prints Esri. The camera is read back on
  // every settle; it is the single source of truth for the print scale.
  const makeMapOpen = makeMapState !== null;
  const [editorCamera, setEditorCamera] = useState<EditorCamera | null>(null);
  // Where the camera was before the editor moved it, restored on exit.
  const preEditorCameraRef = useRef<EditorCamera | null>(null);

  // getViewState() on an uninitialised native view crashes (see the mapLoaded
  // gate's own note), so every read here is behind it.
  const readEditorCamera = useCallback(() => {
    if (!mapLoaded) return;
    void mapRef.current
      ?.getViewState()
      .then((vs) => {
        setEditorCamera({ center: [vs.center[0], vs.center[1]], zoom: vs.zoom });
      })
      .catch(() => undefined); // mid-teardown; the next settle re-reads
  }, [mapLoaded]);

  const requestEditorZoom = useCallback((zoom: number) => {
    void cameraRef.current?.setStop({ zoom: clampZoom(zoom), duration: 260 });
  }, []);

  // Snapshot on open, restore on close — including an unexpected unmount, so a
  // navigation away can never strand the user's map somewhere they never went.
  useEffect(() => {
    if (!makeMapOpen || !mapLoaded) return;
    let cancelled = false;
    // Copied for the cleanup: the ref could point elsewhere by the time this
    // effect tears down (react-hooks/exhaustive-deps).
    const camera = cameraRef.current;
    void mapRef.current
      ?.getViewState()
      .then((vs) => {
        if (cancelled) return;
        const at: EditorCamera = { center: [vs.center[0], vs.center[1]], zoom: vs.zoom };
        preEditorCameraRef.current = at;
        setEditorCamera(at);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      const prev = preEditorCameraRef.current;
      preEditorCameraRef.current = null;
      setEditorStyle(null);
      setEditorCamera(null);
      if (prev) {
        void camera?.setStop({ center: prev.center, zoom: prev.zoom, duration: 400 });
      }
    };
  }, [makeMapOpen, mapLoaded]);

  // Whether the legend+scrubber dock owns the bottom edge right now.
  const weatherDockVisible =
    weatherLayer !== null &&
    !offlineOnly &&
    !selecting &&
    // The map-maker's options sheet owns the bottom edge too — the dock was
    // covering its lower rows ("Contour lines") when weather stayed on.
    makeMapState === null &&
    weatherTl.timeline !== null;
  // Tapping a live waypoint marker opens an editor for its note + photo.
  // Tapping a waypoint marker — a live recording pin or a saved standalone pin
  // — opens the shared editor for its note + photo. The edit target is tagged
  // with its source store so save/delete/photo dispatch to the right one.
  const [editWp, setEditWp] = useState<{ source: 'live' | 'saved'; id: string } | null>(null);
  const [wpDraft, setWpDraft] = useState('');
  // #232 — the editor's Name field, owned here like the note draft.
  const [wpName, setWpName] = useState('');
  /**
   * #232 — a waypoint the editor is composing that does NOT exist yet: both
   * "Add waypoint here" (the tapped point) and the "+" sheet's "Add waypoint"
   * (the GPS fix) now open the form FIRST and create on Done, so the typed
   * name is the waypoint's initial label. Creating up-front and renaming
   * afterwards would burn an auto number on every named waypoint, and would
   * leave a pin behind when the user backs out.
   */
  const [newWp, setNewWp] = useState<WaypointDraft | null>(null);
  // Read-only viewer target (pin tap). Editing is an explicit step from it.
  const [viewWp, setViewWp] = useState<{ source: 'live' | 'saved'; id: string } | null>(null);
  /** The tapped geodetic mark (its summary card is up). */
  const [geodeticMark, setGeodeticMark] = useState<GeodeticMark | null>(null);
  /**
   * The mark whose card still has to bring it into view: set by the tap,
   * consumed ONCE by the card's first layout (when its height is known).
   * After that the camera is the user's — a pan, or the card growing, never
   * moves it back.
   */
  const geodeticRecenterRef = useRef<GeodeticMark | null>(null);
  const geodeticDockRef = useRef<View>(null);
  const mapSizeRef = useRef<{ width: number; height: number } | null>(null);
  /** The tapped tide station (its card is up). */
  const [tideStation, setTideStation] = useState<TideStation | null>(null);
  const findWp = useCallback(
    (ref: { source: 'live' | 'saved'; id: string } | null) =>
      ref === null
        ? null
        : ref.source === 'live'
          ? (waypoints.find((w) => w.id === ref.id) ?? null)
          : (savedWaypoints.find((w) => w.id === ref.id) ?? null),
    [waypoints, savedWaypoints],
  );
  // The editor's subject: an existing waypoint, or the not-yet-created one
  // being composed (#232). Only `label`/`photoUri` are read by the dialog.
  const editWaypoint =
    newWp !== null
      ? {
          label: wpName,
          ...(newWp.photoUri ? { photoUri: newWp.photoUri } : {}),
          ...(newWp.icon ? { icon: newWp.icon } : {}),
        }
      : findWp(editWp);
  const viewWaypoint = findWp(viewWp);

  // --- Drawing tools (#502 routes, #503 areas) -------------------------------
  // While a tool is open every map tap and long-press belongs to it (handled
  // first in onMapPress / onLongPress below), and whatever else owned the
  // screen — the inspect panel, the carousel, a card, the point chip — is
  // closed as it opens. Starting is gated on an idle recorder (the "+" sheet
  // only exists while idle), so drawing never interferes with a recording.
  const closeForDrawing = useCallback(() => {
    inspect(null);
    setHeatSelection(null);
    setViewWp(null);
    setPointAt(null);
    setForecastAt(null);
    setCompactControlsOpen(false);
    setSearchOpen(false);
  }, [inspect]);
  const drawing = useMapDrawing({
    mapRef,
    showSnack,
    units,
    topInset: insets.top,
    onBeforeStart: closeForDrawing,
  });
  // The tap handlers below are memoized; they read the drawing tools through
  // a ref so a fresh session object never has to rebuild them.
  const drawingRef = useRef(drawing);
  useEffect(() => {
    drawingRef.current = drawing;
  });

  const saveWaypoint = () => {
    if (newWp) {
      // Create WITH the typed name (blank falls back to the auto number the
      // field was prefilled with), then fold in whatever the form collected.
      const id = addSavedWaypoint(newWp.latitude, newWp.longitude, wpName);
      const note = wpDraft.trim();
      if (note !== '' || newWp.photoUri || newWp.icon) {
        updateSavedWaypoint(id, {
          ...(note !== '' ? { note } : {}),
          ...(newWp.photoUri ? { photoUri: newWp.photoUri } : {}),
          ...(newWp.icon ? { icon: newWp.icon } : {}),
        });
      }
      setNewWp(null);
      return;
    }
    if (editWp) {
      const note = wpDraft.trim();
      if (editWp.source === 'live') updateWaypoint(editWp.id, { label: wpName, note });
      else {
        updateSavedWaypoint(editWp.id, { note });
        // A blank name is a no-op in both stores — the label is never lost.
        renameSavedWaypoint(editWp.id, wpName);
      }
    }
    setEditWp(null);
  };
  const deleteWaypoint = () => {
    // A composed waypoint was never created, so Delete is simply "discard" —
    // of the draft AND the photo copy only it owned (#306).
    if (newWp) {
      discardDraftPhoto(newWp);
      setNewWp(null);
      return;
    }
    if (editWp) {
      if (editWp.source === 'live') removeWaypoint(editWp.id);
      else removeSavedWaypoint(editWp.id);
    }
    setEditWp(null);
  };
  /**
   * Hold-to-delete straight from the waypoint card (#505) — no detour through
   * the editor. A failed store commit keeps the card up and says so.
   */
  const deleteViewedWaypoint = () => {
    if (!viewWp) return;
    try {
      if (viewWp.source === 'live') removeWaypoint(viewWp.id);
      else removeSavedWaypoint(viewWp.id);
    } catch {
      showSnack('Could not delete the waypoint. Please try again.');
      return;
    }
    setViewWp(null);
    showSnack('Waypoint deleted');
  };
  /**
   * Pick the pin icon (#350). Applied immediately for a saved waypoint — the
   * pin under the dialog redraws with the new mark — and held on the draft for
   * one that does not exist yet, which Done then creates with it.
   *
   * Only offered for standalone waypoints: a live recording waypoint becomes a
   * distance-anchored trail note on stop, and a note has no icon.
   */
  const setWaypointIcon = (icon: WaypointIcon | undefined) => {
    if (newWp) {
      const { icon: _previous, ...rest } = newWp;
      setNewWp(icon ? { ...rest, icon } : rest);
      return;
    }
    if (editWp?.source === 'saved') updateSavedWaypoint(editWp.id, { icon: icon ?? null });
  };

  const setWaypointPhoto = (uri: string) => {
    if (newWp) {
      // '' removes: drop the field (#306 — spreading kept it for Done to save)
      // and unlink the replaced/removed copy the draft owned.
      setNewWp(withDraftPhoto(newWp, uri));
      return;
    }
    if (!editWp) return;
    if (editWp.source === 'live') updateWaypoint(editWp.id, { photoUri: uri });
    else updateSavedWaypoint(editWp.id, { photoUri: uri });
  };

  /**
   * Open the waypoint form on a coordinate that has no record yet (#232) —
   * the chip's "Add waypoint here" (tapped point) and the "+" sheet's "Add
   * waypoint" (GPS fix). The Name box is prefilled with the auto label the
   * store would have minted, so a name left alone numbers exactly as before.
   */
  const composeWaypointAt = useCallback(
    (at: LatLng) => {
      setEditWp(null);
      setViewWp(null);
      setWpName(nextWaypointLabel(savedWaypoints.map((w) => w.label)));
      setWpDraft('');
      setNewWp({ latitude: at.latitude, longitude: at.longitude });
    },
    [savedWaypoints],
  );

  /**
   * Run one of the open point chip's actions — shared by the chip's own
   * responders (iOS) and onMapPress's hit-test (Android, where the marker's
   * children may never see the touch), so both paths close the chip alike.
   * "Add waypoint here" closes it: the new pin takes that exact spot, and a
   * chip left on top of its own pin is the stale, dead bubble of 2026-09-28
   * (see @core/map/mapTap).
   */
  const runPointChipHit = useCallback(
    (hit: PointChipHit, at: LatLng) => {
      if (!chipSurvivesHit(hit)) setPointAt(null);
      if (hit === 'navigate') {
        void openGoToCoordinates(at);
      } else if (hit === 'waypoint') {
        composeWaypointAt(at);
      } else {
        void Clipboard.setStringAsync(formatLatLng(at.latitude, at.longitude));
        showSnack('Coordinates copied');
        setViewWp(null);
        setForecastAt(null);
      }
    },
    [openGoToCoordinates, composeWaypointAt, showSnack],
  );

  // "+" actions menu → Add waypoint: compose a standalone waypoint at the
  // current GPS position (created on Done, see composeWaypointAt).
  const onAddWaypoint = useCallback(() => {
    if (!location) {
      showSnack('Waiting for a GPS fix before dropping a waypoint');
      return;
    }
    composeWaypointAt(location);
  }, [location, composeWaypointAt, showSnack]);

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
  // Item 4: tapping the user's own position dot re-enables follow mode —
  // same screen-projection hit-test idiom as the waypoint pins below, just
  // against the single live location instead of a list of pins.
  const USER_LOCATION_HIT_PX = 40;
  // Trails and heat spots: a thin trace needs a finger-sized tolerance in
  // SCREEN space (≈ a 44 dp target). The heat grid alone is a fixed ~25–50 m
  // on the ground, a couple of pixels once zoomed out to a whole run.
  const TRAIL_HIT_PX = 22;
  // How long a touch the chip's action row claimed keeps the map's own press
  // handler quiet (#232) — long enough to cover the recognizer that fires
  // just after it, short enough that the next deliberate tap goes through.
  const CHIP_ACTION_TOUCH_MS = 600;
  // Tap-routing priority (this handler, in order): the OPEN point chip — its
  // Navigate / Waypoint buttons and its tap-to-copy circle — because it draws
  // above everything else (see @core/map/mapTap for the stale-bubble bug that
  // ordering fixes); else a waypoint pin hit → the existing viewer-card
  // behaviour below; else a heat-spot lookup — a "hot"
  // spot (2+ trails, overlapping) opens the carousel, a single cold trail
  // opens the inspect panel; else the user-location dot (re-engage follow,
  // item 4 — deliberately last among the selection routes, see
  // tapHitsUserDot below); else the tap drops/moves/dismisses the ONE point
  // chip (wave A item 7 + wave D §D1/D-5: coordinates on the plain map, the
  // weather value under a weather layer, the depth in marine mode, both
  // lines when both are on); then deselect. Every pre-existing priority is
  // untouched — the chip route only widened from "weather draped" to "any
  // bare tap".
  //
  // The event's real (runtime + typings) shape is `nativeEvent: { lngLat:
  // [lng, lat]; point: [x, y]; ... }` — flat tuples, NOT the GeoJSON
  // `{ geometry: { coordinates } }` shape one might expect from a "feature
  // press" event. Confirmed against
  // node_modules/@maplibre/maplibre-react-native's PressEvent type.
  //
  // The body takes a COPY of the event (readMapPress, @core/map/mapTap, in
  // onMapPress below): React Native nulls `nativeEvent` as soon as the
  // handler yields, and this one awaits the camera projection before it gets
  // to `lngLat` — reading the event there killed every coordinate route while
  // the bubble or any pin was on screen (2026-09-28).
  const handleMapPress = useCallback(
    async ({ point, lngLat: lngLatArr }: MapPress) => {
      const map = mapRef.current;
      if (!map) return;
      // #232 — the chip's action row already took this touch (see
      // chipTouchAtRef); the map must not act on it a second time.
      if (Date.now() - chipTouchAtRef.current < CHIP_ACTION_TOUCH_MS) return;
      // A drawing tool owns every tap while it is open (#502/#503): pins,
      // trails and the point chip all wait until it closes.
      if (drawingRef.current.active) {
        drawingRef.current.onMapTap(lngLatArr ? [lngLatArr[0], lngLatArr[1]] : null, [
          point[0],
          point[1],
        ]);
        return;
      }
      const [px, py] = point;

      // The open chip, measured up front: routeMapTap puts it ahead of the
      // pins because it is drawn over every one of them. It used to be asked
      // after the pin hit-test, so a pin under the chip (and "Add waypoint
      // here" plants one exactly there) swallowed every tap on the bubble:
      // it stayed up and nothing on it worked (2026-09-28). The row is inert
      // Views (a Pressable in a MapLibre marker stops the whole marker from
      // drawing on iOS — see MapPointChip), so its press handling is this
      // hit-test, the same idiom the waypoint pins use.
      let chipHit: PointChipHit | null = null;
      if (pointAt !== null) {
        try {
          const p = await map.project([pointAt.longitude, pointAt.latitude]);
          if (p != null) chipHit = hitMapPointChip(px - p[0], py - p[1]);
        } catch {
          // projection unavailable mid-teardown — not a chip tap
        }
      }

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
        // One bad pin must never cost the whole tap (#343). This used to
        // project every pin with `Promise.all` and `return` on rejection, so a
        // single stored waypoint the projector refused killed EVERY map tap —
        // silently, because an async handler's throw is swallowed. The phone
        // stayed that way across restarts: the waypoint is in library.json.
        //
        // Projection still goes through the real camera, per pin: a linear
        // mapping over the visible bounds is wrong the moment the map is
        // rotated or pitched (taps would miss, or open the wrong waypoint).
        const skipped = unprojectablePins(visiblePins);
        if (skipped.length > 0) {
          const first = skipped[0];
          reportError(
            new Error(
              `skipping ${skipped.length} waypoint(s) with an unmappable position, e.g. ` +
                `${first?.id ?? '?'} at [${first?.longitude}, ${first?.latitude}]`,
            ),
            'map-tap',
          );
        }
        const projected: ProjectedPin[] = new Array<ProjectedPin>(visiblePins.length).fill(null);
        const results = await Promise.allSettled(
          projectablePins(visiblePins).map(async ({ index, lngLat }) => ({
            index,
            point: await map.project(lngLat),
          })),
        );
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const { index, point } = result.value;
          if (point != null) projected[index] = point;
        }
        best = nearestPinAt(
          visiblePins,
          projected,
          [px, py],
          WAYPOINT_PIN_HIT.radiusPx,
          WAYPOINT_PIN_HIT.badgeOffsetPx,
        );
      }
      const route = routeMapTap(chipHit, best);
      if (route.kind === 'chip' && pointAt !== null) {
        runPointChipHit(route.hit, pointAt);
        return;
      }
      if (route.kind === 'pin') {
        const { pin } = route;
        drawingRef.current.closeAreaCard();
        // Pin tap opens the read-only viewer; a second tap on the same pin
        // (or the card's ✕) closes it. Editing is the card's explicit step.
        setViewWp((cur) =>
          cur?.id === pin.id && cur.source === pin.source
            ? null
            : { source: pin.source, id: pin.id },
        );
        setGeodeticMark(null);
        setTideStation(null);
        return;
      }

      // Tide stations (Overlays → Tide stations): above the survey marks.
      if (tideTiles !== null && lngLatArr) {
        const station = await tideStationAt(map, px, py, [lngLatArr[0], lngLatArr[1]]);
        if (station !== null) {
          drawingRef.current.closeAreaCard();
          setPointAt(null);
          setViewWp(null);
          setForecastAt(null);
          setGeodeticMark(null);
          setTideStation(station);
          return;
        }
      }

      // Geodetic points (Settings → Extensions): under the waypoint pins and
      // the chip, above the trails, heat spots and the bare map. A small box
      // round the finger, the nearest mark in it wins; nothing there (or the
      // query unavailable mid-teardown) falls through to the routes below.
      if (geodeticTiles !== null && lngLatArr) {
        let mark: GeodeticMark | null = null;
        try {
          const features = await map.queryRenderedFeatures(
            [
              [px - GEODETIC_HIT_PX, py - GEODETIC_HIT_PX],
              [px + GEODETIC_HIT_PX, py + GEODETIC_HIT_PX],
            ],
            { layers: [...GEODETIC_TAP_LAYERS] },
          );
          mark = pickTappedMark(features, [lngLatArr[0], lngLatArr[1]]);
        } catch {
          mark = null;
        }
        if (mark !== null) {
          drawingRef.current.closeAreaCard();
          setPointAt(null);
          setViewWp(null);
          setForecastAt(null);
          geodeticRecenterRef.current = mark;
          setTideStation(null);
          setGeodeticMark(mark);
          return;
        }
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
      const at =
        lngLatArr && showTrackOverlays
          ? trackHeat.heatAt(
              { lng: lngLatArr[0], lat: lngLatArr[1] },
              // The finger's tolerance: at least TRAIL_HIT_PX, and the whole
              // visible heat glow when the heatmap is on.
              Math.max(TRAIL_HIT_PX, heatOn ? heatTapRadiusPx(scaleAt?.zoom ?? 16) : 0) *
                (metersPerPixel(scaleAt?.zoom ?? 16, lngLatArr[1]) ?? 0),
              heatOn,
            )
          : { trackIds: [], hot: false };
      if (lngLatArr && at.hot && at.trackIds.length >= 2) {
        drawingRef.current.closeAreaCard();
        inspect(null); // opening the carousel hides the inspect panel
        setHeatSelection({
          lngLat: { lng: lngLatArr[0], lat: lngLatArr[1] },
          trackIds: at.trackIds,
          focusedIdx: 0,
        });
      } else if (at.trackIds.length === 1) {
        drawingRef.current.closeAreaCard();
        setHeatSelection(null); // a single-trail tap hides the carousel
        inspect(at.trackIds[0] ?? null);
      } else {
        // Leaving a focused trail or route (its panel or the heat carousel
        // up) by tapping the map elsewhere (2.1.1, owner): the tap ONLY
        // closes the focus. No point bubble, no area card, no follow, and
        // the camera stays where it is — the pre-focus snapshot is
        // forgotten, not glided back to (the panel's ✕ still glides back).
        if (bareTapAfterFocus(inspectId !== null || heatSelection !== null) === 'leave-focus') {
          setHeatSelection(null);
          inspect(null);
          selectionCamera.forget();
          setViewWp(null);
          setForecastAt(null);
          return;
        }
        // Nothing else claimed the tap — the dot route gets its turn now
        // (item 4: tap your own position dot to resume following after
        // panning away). Checked after heat/trail so it can never steal a
        // heat-spot, trail or waypoint tap that happens to sit under the dot.
        if (await tapHitsUserDot()) {
          setFollowUser(true);
          return;
        }
        // A drawn area under the tap (#503) opens its card — ahead of the
        // point chip, behind every pin, trail and heat spot (a trail inside
        // an area stays tappable). A second tap on the same area closes the
        // card and falls through to the chip.
        if (lngLatArr && drawingRef.current.onAreaTap([lngLatArr[0], lngLatArr[1]])) {
          setPointAt(null);
          setViewWp(null);
          setForecastAt(null);
          return;
        }
        // Point-chip tap (wave A item 7, widened by wave D §D1/D-5),
        // slotted between the dot route and plain deselect: a bare tap
        // drops the readout chip at the tapped spot; a tap ON the chip (or
        // its anchor dot) was already routed at the top of this handler and
        // dismissed it with a copy; a bare tap anywhere else while a chip is
        // open just closes it (#258). On the plain map (no weather, no
        // marine) the chip shows the coordinates and dismissing it copies
        // them, which is the only affordance a pointerEvents-none chip can
        // offer. #97 widened the copy to EVERY mode, since the chip now
        // always carries a coordinates line.
        if (lngLatArr) {
          // #258 — a chip is open and the tap landed on neither its action row
          // nor its copy circle (both handled at the top): close it and do
          // nothing else. Re-dropping the chip at the new spot (the pre-#258
          // behaviour) made it follow the finger around the map with no
          // obvious way to be rid of it. The NEXT tap, on a clean map, drops
          // a fresh chip as before.
          // A survey-mark card is up: this tap only closes it (#258's rule —
          // the chip never drops in the same tap that dismisses a card).
          if (geodeticMark !== null || tideStation !== null) {
            setGeodeticMark(null);
            setTideStation(null);
            return;
          }
          setPointAt(
            pointChipAfterBareTap(pointAt, { latitude: lngLatArr[1], longitude: lngLatArr[0] }),
          );
        }
      }
      setViewWp(null); // tapping empty map dismisses the waypoint viewer
      setForecastAt(null); // ... and the forecast card
      setGeodeticMark(null); // ... and the survey-mark card
      setTideStation(null); // ... and the tide-station card
    },
    [
      geodeticTiles,
      geodeticMark,
      tideTiles,
      tideStation,
      visiblePins,
      trackHeat,
      scaleAt?.zoom,
      heatOn,
      inspect,
      showTrackOverlays,
      inspectId,
      heatSelection,
      selectionCamera,
      location,
      setFollowUser,
      pointAt,
      runPointChipHit,
    ],
  );
  // A tapped survey mark slides into the middle of the map left visible
  // between the top chrome and its card (owner, 2026-10-05) — once, at the
  // card's first layout, keeping the user's zoom. `cardTop` is the dock's y
  // in the map area, the same pixel space as `map.project`.
  const recenterOnGeodeticCard = useCallback(
    (cardTop: number) => {
      const mark = geodeticRecenterRef.current;
      const size = mapSizeRef.current;
      const map = mapRef.current;
      geodeticRecenterRef.current = null;
      if (!mark || !size || !map) return;
      void (async () => {
        try {
          const px = await map.project([mark.lng, mark.lat]);
          const centerPx = cardCameraCenterPx({
            featurePx: [px[0], px[1]],
            mapSize: size,
            visibleTop: insets.top + MAP_TOP_CHROME_PX,
            visibleBottom: cardTop,
          });
          if (centerPx === null) return;
          const center = await map.unproject(centerPx);
          // Following would drag the camera straight back to the puck.
          if (useMapStore.getState().followUser) setFollowUser(false);
          // A jump, not an ease: an animated move got cut short on iOS (the
          // card mounting mid-flight), and a jump can't fight a user who
          // starts panning straight away.
          cameraRef.current?.jumpTo({ center: [center[0], center[1]] });
        } catch {
          // map mid-teardown: the mark just stays where it is
        }
      })();
    },
    [insets.top, setFollowUser],
  );

  const onMapPress = useCallback(
    (e: MapPressEvent) => {
      gesturePause.tap();
      const press = readMapPress(e); // synchronously, before anything awaits
      // The search highlight (#496) is temporary: any tap on the map clears it.
      setSearchHit(null);
      if (press) void handleMapPress(press);
    },
    [gesturePause, handleMapPress],
  );

  const trailFeature = useThrottledLineFeature(points, segmentStarts);

  // Camera seed: live fix → persisted last known position → MapLibre default.
  // `location` covers a remount with the live fix already in hand;
  // `lastKnownPosition` covers the cold start, where the first fix may be
  // minutes away (indoors) — without it the map opened on [0,0], null island.
  const initialCenter = resolveInitialCenter(location, lastKnownPosition);

  // Which trail is "selected": a tap-selected heat spot (the carousel) wins,
  // otherwise whichever trail is open in the inspect panel. When ANY trail is
  // selected, every other trail is hidden outright (not dimmed) via the lines
  // layer's filter below — see item 1's selection-visibility rule.
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

  // The 3D scene's own trails (lifted onto the relief): the shown trails (or
  // only the focused one, as in 2D), and the live recording on top.
  const terrainLines = useMemo(() => {
    if (!terrain3d.active) return NO_TERRAIN_LINES;
    const outline = LINE_OUTLINE[lineOutline];
    const base = {
      color: mapColors.trail,
      halo: outline.color,
      haloOpacity: outline.opacity,
      haloAdd: outline.widthAdd,
    };
    const shown =
      showTrackOverlays && trackHeat.lines && !hasSelection
        ? sceneLines(
            trackHeat.lines.features.map((f) => ({
              geometry: f.geometry,
              color: f.properties.color,
            })),
            { ...base, width: 3, order: 0 },
            0,
          )
        : [];
    const focus = focusLine
      ? sceneLines(
          [{ geometry: focusLine.geometry, color: focusLine.properties.color }],
          { ...base, width: 4, order: 1 },
          1_000_000,
        )
      : [];
    const live = trailFeature
      ? sceneLines(
          [{ geometry: trailFeature.geometry }],
          {
            color: mapColors.trail,
            halo: mapColors.trailCasing,
            haloOpacity: 1,
            width: 5,
            haloAdd: 4,
            order: 2,
          },
          2_000_000,
        )
      : [];
    return [...shown, ...focus, ...live];
  }, [
    terrain3d.active,
    lineOutline,
    showTrackOverlays,
    trackHeat.lines,
    hasSelection,
    focusLine,
    trailFeature,
  ]);
  useNativeTerrainScene(
    terrain3d.active ? terrain3d.viewTag : null,
    terrainLines,
    location ? { lng: location.longitude, lat: location.latitude } : null,
  );

  // --- Offline marine packs (marine wave D §D4) ---------------------------
  // Hydrate the inventory once, then sweep for packs older than 30 days each
  // time the app comes forward online. The sweep is silent by design: it
  // refreshes in place and leaves yesterday's grid alone when it fails.
  const marinePackSnoozes = useSettingsStore((s) => s.marinePackSnoozes);
  const marinePackAutoUpdate = useSettingsStore((s) => s.marinePackAutoUpdate);
  const setSetting = useSettingsStore((s) => s.set);
  //
  // PARKED (see `@core/features/flags`): this pair is the ONE marine code
  // path that does not hang off `marineActive` — it hydrates and re-downloads
  // packs on every cold start and every foreground, whether or not chart mode
  // is on. So it needs its own flag guard, or a parked feature would still
  // put pack downloads on the wire.
  useEffect(() => {
    if (!MARINE_ENABLED) return;
    void useMarinePackStore.getState().hydrate();
  }, []);
  useEffect(() => {
    if (!MARINE_ENABLED || !marinePackAutoUpdate || offlineOnly) return;
    const sweep = (): void => {
      // hydrate() may still be in flight on a cold start; chaining off it
      // means the first sweep sees the real inventory instead of an empty one.
      const store = useMarinePackStore.getState();
      void (store.hydrated
        ? store.refreshStale()
        : store.hydrate().then(() => store.refreshStale()));
    };
    sweep();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') sweep();
    });
    return () => sub.remove();
  }, [marinePackAutoUpdate, offlineOnly]);

  // The low-resolution prompt. Entirely decided by a pure function so the
  // "never nag" rule is unit-tested rather than hoped for. Snooze EXPIRY is
  // applied at settings hydration, which keeps the trigger clock-free and
  // therefore legal to evaluate during render.
  const snoozedRegionKeys = useMemo(
    () => snoozedPackRegions(marinePackSnoozes),
    [marinePackSnoozes],
  );
  const marinePackOfferState = useMemo(
    () =>
      marinePackOffer({
        active: marineActive && !selecting && makeMapState === null,
        view: settledBounds,
        activeSourceId: marineChart.sourceId,
        installed: installedPacks,
        snoozedRegions: snoozedRegionKeys,
      }),
    [
      marineActive,
      selecting,
      makeMapState,
      settledBounds,
      marineChart.sourceId,
      installedPacks,
      snoozedRegionKeys,
    ],
  );
  const onDownloadMarinePack = useCallback(() => {
    if (marinePackOfferState === null) return;
    const { source, cells } = marinePackOfferState;
    void useMarinePackStore
      .getState()
      .download(source, cells)
      .then((stored) => {
        if (stored > 0) {
          showSnack('Marine chart pack downloaded');
          return;
        }
        // Nothing surveyed here after all: snooze the region so the banner
        // doesn't immediately offer the same empty download again.
        showSnack('No marine data available for this area');
        setSetting('marinePackSnoozes', [
          ...marinePackSnoozes,
          encodePackSnooze(marinePackOfferState.regionKey, Date.now() + MARINE_PACK_SNOOZE_MS),
        ]);
      })
      .catch((err: unknown) => {
        showSnack(err instanceof Error ? err.message : 'Marine pack download failed');
      });
  }, [marinePackOfferState, marinePackSnoozes, setSetting, showSnack]);
  const onSnoozeMarinePack = useCallback(() => {
    if (marinePackOfferState === null) return;
    setSetting('marinePackSnoozes', [
      ...marinePackSnoozes,
      encodePackSnooze(marinePackOfferState.regionKey, Date.now() + MARINE_PACK_SNOOZE_MS),
    ]);
  }, [marinePackOfferState, marinePackSnoozes, setSetting]);

  // A long-distance trail shown from Explore (#467): its sheet owns the
  // bottom edge only while nothing else does (recording, region select, the
  // map maker, a trail inspector, the heat carousel).
  const trailSheetUp =
    shownTrail !== null &&
    status === 'idle' &&
    !selecting &&
    makeMapState === null &&
    !inspectId &&
    heatSelection === null &&
    !drawing.ownsBottom;

  const {
    ref: mapAreaRef,
    onLayout: onMapAreaLayout,
    value: mapAreaBottom,
  } = useWindowEdge('bottom');
  // One host View feeds both the window-edge measure and the native terrain,
  // which finds the MapLibre view inside it (collapsable: keep it a real view).
  const setMapAreaView = useCallback(
    (v: View | null) => {
      mapAreaRef.current = v;
      terrainHostRef.current = v;
    },
    [mapAreaRef],
  );
  return (
    <MapAreaBottomContext.Provider value={mapAreaBottom}>
      <View
        style={styles.fill}
        ref={setMapAreaView}
        collapsable={false}
        onLayout={(e) => {
          mapSizeRef.current = {
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          };
          onMapAreaLayout();
        }}
      >
        {!settingsHydrated ? null : ( // wait for the persisted camera seed (a few ms at launch)
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
            onLongPress={(e: {
              nativeEvent?: { lngLat?: [number, number]; point?: [number, number] };
            }) => {
              gesturePause.tap();
              // Drawing (#502/#503): a long-press on a vertex deletes it, and
              // never drops a destination pin under the tool.
              if (drawingRef.current.active) {
                void drawingRef.current.onMapLongPress(e.nativeEvent?.point ?? null);
                return;
              }
              const lngLat = e.nativeEvent?.lngLat;
              if (!lngLat) return;
              const at = { longitude: lngLat[0], latitude: lngLat[1] };
              // Weather/marine gesture (unchanged): long-press opens the
              // forecast card (ECCC forecast + CHS tides) for that point.
              if ((weatherLayer !== null || marineActive) && !offlineOnly) {
                setForecastAt(at);
                return;
              }
              // Bare map: long-press DROPS THE DESTINATION PIN (#97). This is
              // the "drop a pin" gesture people already expect, and it costs no
              // permanent chrome — the only thing it adds to the screen is the
              // pin and its readout chip, both of which the ✕ clears. A second
              // long-press moves the pin rather than stacking another.
              setDestination(at);
              showSnack(`Destination set — ${formatLatLng(at.latitude, at.longitude)}`);
            }}
            // NOT onWillStartLoadingMap -> setMapLoaded(false): that fires on
            // every STYLE reload as well as a real (re)mount, and the false
            // switched the marine chart off, which changed the style, which
            // reloaded it again — a self-sustaining storm measured at ~15
            // style reloads per second (perf fix 2026-08-10). The gate exists
            // to keep getViewState() off an uninitialised native view, and
            // only an unmounted <Map> can put us back in that state — which
            // the effect above re-arms.
            // The style is parsed and the native view exists: safe for
            // getViewState(). Same reasoning as the region-change hook below.
            onDidFinishLoadingStyle={() => {
              setMapLoaded(true);
              tilt.onStyleLoaded();
            }}
            onDidFinishLoadingMap={() => {
              setMapLoaded(true);
              // Seed the scale bar: onRegionDidChange is not guaranteed to fire
              // before the user's first gesture, and a map with no scale on it
              // until you pan looks broken.
              void mapRef.current
                ?.getViewState()
                .then((vs) => {
                  updateScaleAt(vs.zoom, vs.center[1]);
                  onSettleBearing(vs.bearing);
                  tilt.onSettledPitch(vs.pitch);
                  onContourSettled(vs);
                })
                .catch(() => undefined); // mid-teardown — the next settle seeds it
            }}
            // Feeds the crossfade's "is the staged frame actually drawn yet"
            // gate (see useWeatherCrossfade). A ref, so this fires at render
            // rate without costing a React update.
            onDidFinishRenderingFrameFully={() => {
              renderedFramesRef.current += 1;
            }}
            // Wind particles track the camera at gesture rate; the handler is
            // only attached while the overlay is live (zero event traffic
            // otherwise — the map stays byte-identical to a windless one).
            // Once per camera move (not per frame): marks the PERSON's pans and
            // zooms so the mascot bubble waits for a still map (#476); the mug
            // keeps animating regardless. Programmatic moves (follow-my-location
            // nudges every fix) never count; see gesturePause for the iOS tap
            // trap this guards against.
            onRegionWillChange={(e) => {
              gesturePause.willChange(e.nativeEvent.userInteraction === true);
            }}
            onRegionIsChanging={windEnabled ? onWindRegionIsChanging : undefined}
            onRegionDidChange={(e) => {
              gesturePause.didChange();
              // A settled camera is proof the native map is up: in some sessions
              // (seen on iOS in the mountains, 2026-09-28) onDidFinishLoadingMap
              // never fires, which left every mapLoaded-gated feature dead — the
              // offline/map-maker selectors stuck on "Calculating…", no slope or
              // contour overlays. React bails out when it is already true.
              setMapLoaded(true);
              setRegionVersion((v) => v + 1);
              // The selected drawing point's grip follows the camera (#502/#503).
              drawingRef.current.onCameraSettled();
              // The map-maker frame's scale and bbox come straight off the
              // settled camera (#349) — it is the only source of truth for both.
              if (makeMapOpen) readEditorCamera();
              // Settled bounds for the marine chart's re-anchor check (the
              // wind layer keeps its own copy behind the windEnabled gate).
              setSettledBounds(windBoundsOf(e.nativeEvent));
              updateScaleAt(e.nativeEvent.zoom, e.nativeEvent.center[1]);
              // Settled bearing → the badge's red north needle, and the
              // snap-back detent for a rotation too small to have been meant.
              onSettleBearing(e.nativeEvent.bearing);
              // Settled pitch → the tilted-map relief pass (#480).
              tilt.onSettledPitch(e.nativeEvent.pitch);
              // Settled view → look for contour tiles that failed to load.
              onContourSettled(e.nativeEvent);
              // Settled centre → mapStore (wave B): resolves the effective
              // forecast model and the radar rows' "Canada only" hint. Same
              // render batch as the version bump above — no extra re-render.
              setMapCenter({
                latitude: e.nativeEvent.center[1],
                longitude: e.nativeEvent.center[0],
              });
              void refreshBounds();
              if (windEnabled) onWindRegionDidChange(e);
            }}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              windSizeRef.current = { width, height };
              // A camera state seeded (or streamed) before this layout carries
              // a stale size; re-stamp it so the particle projection can never
              // be left scaled to a zero-width viewport.
              if (windViewRef.current !== null) {
                windViewRef.current = { ...windViewRef.current, width, height };
              }
              setWindLayout((prev) =>
                prev.width === width && prev.height === height ? prev : { width, height },
              );
              onMapLayout(e);
            }}
          >
            <Camera
              ref={cameraRef}
              // A cold launch mounts <Map>/<Camera> fresh;
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
              // 0, the lowest MapLibre allows: at z1 the world is ~1,000 pt wide,
              // so a phone could never show more than part of it ("half of the
              // world isn't visible when fully zoomed out", owner 2026-09-28).
              // At z0 it is ~512 pt: the whole globe top to bottom.
              minZoom={0}
              // Camera cap; the raster SOURCES cap their tile-fetch zoom lower
              // (see NATIVE_MAX_ZOOM in mapStyle.ts) so zooming past each
              // service's real data — or past an offline pack's deepest stored
              // zoom — overscales the last real tiles (blurry) instead of
              // rendering Esri's "Map data not yet available" placeholders or
              // blank offline tiles.
              maxZoom={18}
            />

            {/* Live drapes, mounted as MapView children rather than style-JSON
              layers (perf fix 2026-08-10). A changed `mapStyle` object makes
              maplibre-react-native reload the ENTIRE native style — every
              source rebuilt, every tile refetched, the vector coastlines and
              labels dropped — which is what made playback blink and marine
              mode thrash. As children they update incrementally.

              Their z-order does NOT come from this mount order — a child is
              inserted immediately below the layer it names, and every style
              reload re-inserts them all — so each names its OWN invisible
              anchor layer, which `buildOsmStyle` places at exactly the
              height that drape must occupy (see `@core/geo/mapLayerStack`).
              The PDF overlays and trails below carry no anchor at all, which
              is what keeps them on top of everything. */}
            {/* The tilted-map relief pass (#480): adopts the style's own hidden
              layer of that id (right above the base hillshade) and sets its
              visibility/exaggeration from the settled pitch. */}
            {tilt.layer}
            {marineActive && <MarineDrapeLayer drape={marineChart.chart?.drape ?? null} />}
            {weatherLayer !== null && !offlineOnly && (
              <WeatherDrapeLayers
                fade={weatherFade}
                frames={weatherDrape.frames}
                // Wind runs LIGHTER than every other weather layer, and
                // deliberately so: it is the only layer that also draws its own
                // ink on top. The value and the ladder of everything tried before
                // it live with the constant in @core/weather/windLook.
                opacity={weatherLayer === 'wind' ? WIND_DRAPE_OPACITY : WEATHER_DRAPE_OPACITY}
              />
            )}
            {marineActive && (
              <MarineSoundingsLayer
                soundings={overlayTiles !== null ? (marineChart.chart?.soundings ?? null) : null}
              />
            )}

            {showPdfOverlay &&
              overlays.map((o) => (
                <Fragment key={o.id}>
                  <ImageSource id={o.id} url={o.imageUri} coordinates={o.coordinates}>
                    {pdfOverviewLayer(o.id)}
                  </ImageSource>
                  {pdfDetails
                    .filter((d) => (d.parentId ?? d.id) === o.id)
                    .map((d) => (
                      <ImageSource
                        key={`${d.id}-detail-${fnv1a32(d.imageUri)}`}
                        id={`${d.id}-detail-${fnv1a32(d.imageUri)}`}
                        url={d.imageUri}
                        coordinates={d.coordinates}
                      >
                        {pdfDetailLayer(`${d.id}-detail-${fnv1a32(d.imageUri)}`)}
                      </ImageSource>
                    ))}
                </Fragment>
              ))}

            {/* Terrain overlays sit UNDER the PDF maps on both base maps
              (#492): the slope raster over the relief and under the names,
              on-device contours (the raster fallback) with the contours.
              Their heights come from `@core/map/layerSlots`, not from this
              mount order. */}
            {terrainOverlays2d.slope && (
              <ImageSource
                id="slope2d"
                url={terrainOverlays2d.slope.uri}
                coordinates={terrainOverlays2d.slope.coordinates}
              >
                {SLOPE_LAYER}
              </ImageSource>
            )}
            {/* On-device contours (raster fallback only — both vector bases
              draw the served ones in the style). They must contrast with the
              ground: white over satellite imagery (mostly dark), the warm
              brown over the light map/relief basemaps — each with a thin
              opposite-shade halo so lines stay readable across mixed terrain
              (line layers can't sample the raster beneath, so this is
              per-basemap, not per-pixel). */}
            {terrainOverlays2d.contours && (
              <GeoJSONSource id="contours2d-minor" data={terrainOverlays2d.contours.minor}>
                {contourLayerSet.minor}
              </GeoJSONSource>
            )}
            {terrainOverlays2d.contours && (
              <GeoJSONSource id="contours2d-major" data={terrainOverlays2d.contours.major}>
                {contourLayerSet.major}
              </GeoJSONSource>
            )}

            {/* Drawn areas (#503) and the shape being drawn (#502/#503): user
              content, above the PDF maps and terrain overlays, at the
              trails' anchor (see useMapDrawing / DrawLayers). */}
            {drawing.mapLayers}

            {/* The personal heatmap (#470), over EVERY qualifying trail in the
              library while the toggle is on (independent of visibility
              mode/folder filters/activeTrackIds — see qualifiesForHeat):
              a soft glow from the coarse pass grid when zoomed out, fading
              into crisp pass-count lines that follow the streets actually
              travelled (one pass a clearly visible warm line, many passes
              hot). Both sources are bounded by the ground covered, not by
              how many trails or fixes there are, and are serialized once per
              data change. Drawn BEFORE the trail lines below so they sit
              beneath them. */}
            {heatOn && heatGlowJson && (
              <GeoJSONSource id="tracks-heat-glow-points" data={heatGlowJson}>
                {heatLayerSet.glow}
              </GeoJSONSource>
            )}
            {heatOn && heatLinesJson && (
              <GeoJSONSource id="tracks-heat-lines-source" data={heatLinesJson}>
                {heatLayerSet.lines}
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
            {showTrackOverlays && linesJson && (
              <GeoJSONSource id="tracks-lines" data={linesJson}>
                {hasSelection
                  ? TRACKS_LINES_LAYERS[lineOutline].hidden
                  : TRACKS_LINES_LAYERS[lineOutline].shown}
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
                {FOCUSED_TRAIL_LAYERS[lineOutline]}
              </GeoJSONSource>
            )}

            {/* A long-distance trail shown from Explore (#467). */}
            {shownTrail !== null && <ShownTrailLayers shown={shownTrail} />}

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
                  beforeId={MARKERS_ANCHOR}
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

            {/* Geodetic points: the symbols the style's layers name, and a
              ring under the mark whose card is up. */}
            {geodeticTiles !== null && (
              <Images images={geodeticImages(theme.dark ? 'dark' : 'light')} />
            )}
            {tideTiles !== null && <Images images={tideImages(theme.dark ? 'dark' : 'light')} />}
            {tideTiles !== null && tideStation !== null && (
              <GeoJSONSource
                id="tide-selected"
                data={{
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [tideStation.lng, tideStation.lat] },
                  properties: {},
                }}
              >
                <Layer
                  id="tide-selected-ring"
                  beforeId={MARKERS_ANCHOR}
                  type="circle"
                  paint={{
                    'circle-radius': 17,
                    'circle-color': tideColors(theme.dark ? 'dark' : 'light').station,
                    'circle-opacity': 0.16,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': tideColors(theme.dark ? 'dark' : 'light').station,
                  }}
                />
              </GeoJSONSource>
            )}
            {geodeticTiles !== null && geodeticMark !== null && (
              <GeoJSONSource
                id="geodetic-selected"
                data={{
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [geodeticMark.lng, geodeticMark.lat] },
                  properties: {},
                }}
              >
                <Layer
                  id="geodetic-selected-ring"
                  beforeId={MARKERS_ANCHOR}
                  type="circle"
                  paint={{
                    'circle-radius': 13,
                    'circle-color': geodeticColors(theme.dark ? 'dark' : 'light')[
                      geodeticMark.type
                    ],
                    'circle-opacity': 0.18,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': geodeticColors(theme.dark ? 'dark' : 'light')[
                      geodeticMark.type
                    ],
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
                {INSPECT_MARKER_LAYER}
              </GeoJSONSource>
            )}

            {trailFeature && (
              <GeoJSONSource id="trail" data={trailFeature}>
                {LIVE_TRAIL_LAYERS}
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
                  icon={w.source === 'saved' ? w.icon : undefined}
                  hasPhoto={!!w.photoUri}
                  label={w.label}
                  selected={viewWp?.id === w.id && viewWp.source === w.source}
                />
              </Marker>
            ))}

            {/* Destination pin (#97). Visual only, like the waypoint pins —
              it is cleared from the chip's ✕, never by tapping the map, so a
              destination survives every other tap interaction. */}
            {destination !== null && (
              <Marker
                id="destination"
                lngLat={[destination.longitude, destination.latitude]}
                anchor="bottom"
              >
                <DestinationMarkerPin />
              </Marker>
            )}

            {/* Place-search highlight (#496): where the last pick landed. */}
            {searchHit !== null && (
              <Marker
                id="search-hit"
                lngLat={[searchHit.longitude, searchHit.latitude]}
                anchor="bottom"
              >
                <SearchHitMarker place={searchHit} />
              </Marker>
            )}

            {/* Tap-anywhere readout chip (wave A item 7, unified by wave D
              §D1/D-5): ONE compact Windy-style chip at the tapped spot —
              the weather value pinned to the scrubbed TIME, the surveyed
              NONNA depth in marine mode, both stacked when both are on, and
              plain coordinates on the bare map. Each line owns its own fetch
              hook, so a silent failure only drops its own line. Visual only
              — dismissal (and the coordinates copy) is hit-tested in
              onMapPress (Marker onPress doesn't fire on Android, the
              waypoint-pin precedent). */}
            {pointAt !== null && (
              <Marker id="map-point" lngLat={[pointAt.longitude, pointAt.latitude]} anchor="bottom">
                {/* #232 — the chip is the hub for the two things you can do
                  with a point you can see. Compact, in the chip, gone with
                  it; the row's taps arrive through onMapPress above. */}
                <MapPointChip
                  accessibilityLabel="Map point readout"
                  actions={{
                    onNavigate: () => runPointChipHit('navigate', pointAt),
                    onAddWaypoint: () => runPointChipHit('waypoint', pointAt),
                    onClaimTouch: () => {
                      chipTouchAtRef.current = Date.now();
                    },
                  }}
                >
                  {weatherLayer !== null && !offlineOnly && (
                    <WeatherPointLine
                      at={pointAt}
                      layer={weatherLayer}
                      model={weatherModel}
                      timeIso={weatherTl.timeParam}
                      selectedMs={weatherTl.selectedMs}
                    />
                  )}
                  {marineActive && <DepthPointLine at={pointAt} />}
                  {/* Coordinates (#97): promoted from "only on the bare map" to
                    ALWAYS — a nav app that hides where you just tapped behind
                    a weather value is answering the wrong question. This is
                    the app's one coordinate readout for a point you can see;
                    the map CENTRE's readout lives in the coordinates dialog
                    rather than in a second competing chip. */}
                  <MapPointLine text={formatLatLng(pointAt.latitude, pointAt.longitude)} />
                  {/* How far and which way from where you stand (#232) — the
                    same two numbers the destination chip shows, straight off
                    the current fix. Silently absent without one. */}
                  {pointReadout !== null && (
                    <MapPointLine
                      text={`${pointReadout.distance}  ·  ${pointReadout.bearing}`}
                      muted
                    />
                  )}
                  <MapPointLine text="Tap to copy" muted />
                </MapPointChip>
              </Marker>
            )}

            {/* Direction cone under the dot. The built-in `heading` arrow was
              dropped: it points along the GPS course (garbage while standing
              still); the cone tracks the smoothed compass instead. */}
            <HeadingCone location={location} />
            {/* Revamp puck, replacing MapLibre's default one (children do):
              halo, ring and dot in the scheme's puck tokens, plus the amber
              uncertainty ring on a weak signal while recording. */}
            <UserLocation animated>
              <PuckLayers
                weakAccuracyM={status !== 'idle' && gpsQuality === 'weak' ? lastAccuracyM : null}
              />
            </UserLocation>
          </Map>
        )}

        {/* Wind particle overlay (weather M3): a transparent GLView riding
          absolute-fill over the 2D map, under every piece of chrome below.
          Touches pass straight through (pointerEvents none). One gate —
          windEnabled — kills the whole thing; degradation without network
          is the gradient drape alone. */}
        {windEnabled && (
          <WindParticleLayer
            model={effectiveModel}
            timeIso={weatherTl.timeParam}
            viewRef={windViewRef}
            interacting={windInteracting}
            settledBounds={windSettledBounds}
          />
        )}

        {/* Region select overlay for offline download */}
        {selecting && (
          <RegionSelectOverlay
            toGeo={toGeo}
            boundsVersion={boundsVersion}
            refreshBounds={refreshBounds}
            activeBasemap={basemap}
            tileUrl={tileUrl}
            onCancel={cancelRegionSelect}
            onConfirm={confirmDownload}
          />
        )}

        {/* Map maker (#349): a full-screen editor over the LIVE map. There is no
          region-box step any more — the sheet on screen IS the selection, and
          the bbox is read off the camera when Create is tapped. */}
        {makeMapState !== null && (
          <MapMakerEditor
            camera={editorCamera}
            progress={makeMapState.phase === 'generating' ? makeMapState.progress : null}
            onRequestZoom={requestEditorZoom}
            onStyleChange={setEditorStyle}
            onCreate={(bbox, options, scaleDenom) => startMakeMap(bbox, { ...options, scaleDenom })}
            onCancel={cancelMakeMap}
          />
        )}

        {/* Top-left compass (decision 1): snug to the safe area. */}
        <View style={[styles.topLeft, { top: insets.top + 8 }]} pointerEvents="box-none">
          <CompassBadge onPress={resetNorth} mapBearing={mapBearing} />
        </View>

        {/* "Search places" between the compass and the rail (revamp Main.html).
          Opens the place search (#496): towns, peaks, lakes, campgrounds by
          name, or a coordinate. Same gates as the rail, plus the offline-area
          selector, whose box starts right under it. Stands aside while a
          drawing tool owns the top (#502/#503). */}
        {makeMapState === null && heatSelection === null && !selecting && !drawing.active && (
          <View style={[styles.searchPill, { top: insets.top + 8 }]} pointerEvents="box-none">
            {/* A shown long-distance trail takes the pill's place (#467). */}
            {shownTrail !== null ? (
              <ShownTrailPill shown={shownTrail} />
            ) : (
              !searchOpen && <MapSearchPill onPress={() => void openPlaceSearch()} />
            )}
          </View>
        )}
        {searchOpen && !drawing.active && (
          <View style={[styles.searchSheet, { top: insets.top + 8 }]} pointerEvents="box-none">
            <PlaceSearchSheet
              origin={location}
              bias={searchBias}
              onSelect={onPickPlace}
              onClose={closePlaceSearch}
            />
          </View>
        )}

        {/* Mandatory marine notice (marine M3): whenever a marine layer is
          draped, the "Not for navigation" chip pins top-centre — between the
          compass (left) and the controls rail (right). A plain overlay chip
          like the GPS warning, never a Portal/Dialog. */}
        {marineActive && (
          <View
            style={[styles.marineChip, { top: insets.top + TOP_CHIP_OFFSET }]}
            pointerEvents="none"
          >
            <MarineDisclaimerChip />
          </View>
        )}

        {/* Destination readout (#97): top-centre, between the compass+scale
          stack (left) and the controls rail (right) — the same free lane the
          marine notice uses, so the two are mutually exclusive. Only while a
          destination exists; the ✕ on it is the way out. */}
        {destination !== null && !marineActive && (
          <View
            style={[styles.topCenterChip, { top: insets.top + TOP_CHIP_OFFSET }]}
            pointerEvents="box-none"
          >
            <DestinationChip readout={destReadout} onClear={() => setDestination(null)} />
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
            following={followUser}
            onStopFollowing={() => setFollowUser(false)}
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
            pdfOverlayCount={overlays.length}
            trackOverlayCount={drawnTrackCount}
            // "+" map actions (wave A item 6): moved out of the bottom-right
            // FAB.Group into the rail, directly below Map overlays. Hidden
            // (undefined) while a recording is under way (the active controls
            // take over), while selecting a region, and while the category
            // sheet is deciding — the same gates the old FAB carried. The
            // bottom-corner-specific gates (#131 inspect overlap, the model
            // sheet's perch, the weather-dock lift) are gone with the corner.
            actions={
              status === 'idle' && !selecting && !pickingCategory && !drawing.active
                ? {
                    onRecord: () => setPickingCategory(true),
                    onAddWaypoint,
                    // A second download would stop the first's loopback server.
                    onDownload:
                      downloadProgress !== null
                        ? undefined
                        : () => {
                            // Close any open trail inspector first: the download
                            // sheet renders below the inspector panel (#131).
                            inspect(null);
                            beginRegionSelect();
                          },
                    // No "Navigate to coordinates" or "Settings" rows (owner,
                    // 2026-10-01): tapping the map offers Navigate, Search places
                    // takes coordinates, and the other tabs carry the gear.
                    // The editor frames the sheet over the live map, so it needs
                    // the flat 2D camera — but no region box and no extra step.
                    onMakeMap: () => {
                      inspect(null);
                      setMakeMapState({ phase: 'editing' });
                    },
                    // Drawing (#502/#503) taps the flat 2D map; "Draw" asks
                    // route or area first.
                    onDraw: drawing.openChooser,
                  }
                : undefined
            }
            compactOpen={compactControlsOpen}
            onCompactOpenChange={setCompactControlsOpen}
            onMenuOpenChange={setRailMenuOpen}
          />
        )}

        {permission === 'denied' && (
          <Banner
            visible
            style={[styles.banner, { top: insets.top + 8 }]}
            icon="map-marker-off"
            actions={[]}
          >
            Location permission denied. Enable it in Settings to see your position and record
            trails.
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
        {/* Wave A item 1 (dock gap): NO insets.bottom here. This screen sits
          ABOVE the tab bar, and the tab bar already absorbs the gesture-nav
          inset itself — padding it again double-paid the inset and floated
          the weather dock (and recording bar) ~1 cm off the bar. A few dp of
          fixed breathing room is all the column needs. */}
        <View
          style={[
            styles.bottom,
            recordingPanelUp && { bottom: panelHeight },
            trailSheetUp && { bottom: trailSheetHeight },
            drawing.panelHeight > 0 && { bottom: drawing.panelHeight },
          ]}
          pointerEvents="box-none"
          onLayout={(e) => setBottomColumnH(e.nativeEvent.layout.height)}
        >
          {/* Pages still in the rasterizer, one dismissible row each (#269).
            First in the column so they stack above the scale bar. */}
          <RenderingToasts />
          {/* Scale bar, bottom-left (owner call, 2026-09-08 — #97 had docked it
            under the compass). It is the FIRST child of the bottom chrome
            COLUMN rather than absolutely positioned in the corner, so it
            stacks ABOVE the recording bar, the marine legend and the weather
            dock instead of colliding with them; with none of those up it sits
            just above the tab bar, in the cartographic corner. */}
          {/* Scale bar + the basemap credit as quiet text (left) and the tip button
            (right, Map only, #476) share one row. The ⓘ credit button is gone:
            its corner holds the tip button, and the full roll is in Settings ›
            System info. The short credit STAYS on the map as text because
            OpenStreetMap's attribution guideline and Esri's terms expect it
            on the map view itself.
            Recording starts from "+" → Record track (owner call, 2026-09-27:
            no separate Record button over the map). */}
          {/* Not while the region selector or the map maker owns the bottom
            edge: their sheets sit in this column's footprint, and the row
            would draw over their Cancel / Download / Next buttons. */}
          {!selecting && makeMapState === null && (
            <View
              style={styles.bottomRow}
              pointerEvents="box-none"
              onLayout={(e) => setBottomRowY(e.nativeEvent.layout.y)}
            >
              {/* 2.1.1: the credit caption became a small ⓘ LEFT of the scale bar;
                it opens the credits sheet (every source on screen, the routing
                engine while a routed route is up, "Report a map error"). */}
              <View style={[styles.bottomSide, styles.bottomSideStart]} pointerEvents="box-none">
                <MapCreditsButton onPress={() => setCreditsOpen(true)} />
                {showScaleBar && scaleAt !== null && (
                  <ScaleBar zoom={scaleAt.zoom} latitude={scaleAt.latitude} />
                )}
              </View>
              {/* The tip button hides itself while recording, while a destination is
                followed, and while a trail sheet, heat carousel or the coordinate
                dialog is up. */}
              <View style={[styles.bottomSide, styles.bottomSideEnd]} pointerEvents="box-none">
                <TipButton
                  navigating={destination !== null}
                  gestureActive={cameraMoving}
                  focused={isFocused}
                  bubbleBlocked={
                    railMenuOpen ||
                    creditsOpen ||
                    trailSheetUp ||
                    pickingCategory ||
                    recordRequested ||
                    modelSheetOpen ||
                    selecting ||
                    makeMapState !== null
                  }
                  blocked={inspectId !== null || heatSelection !== null || goToOpen}
                />
              </View>
            </View>
          )}
          {/* Depth legend (marine wave D §D2): the chart's quantized band
            scale, in the same bottom column as the weather dock and above it
            (the weather scrubber must keep the bottom edge). Only while the
            chart drape can actually be on screen — and never while the
            region selector or the map maker owns the bottom edge, the same
            gates the weather dock carries. */}
          {marineActive && !selecting && makeMapState === null && (
            <MarineLegend
              source={marineChartSource(marineChart.sourceId)}
              offline={marineChart.chart?.offline ?? false}
            />
          )}
          {/* Offline marine pack offer (wave D §D4): a quiet Surface row in
            the bottom stack — never a Dialog, never a Portal (One UI
            touch-swallow), and snoozed for 30 days by "Not now". */}
          {marinePackOfferState !== null && (
            <MarinePackBanner
              offer={marinePackOfferState}
              progress={packProgress}
              onDownload={onDownloadMarinePack}
              onDismiss={onSnoozeMarinePack}
            />
          )}
          {/* Weather dock (weather UX M1): the value-legend pill + time
            scrubber, riding the same bottom flex column as the recording bar
            — the column stacks them, so they never overlap it. Hidden with
            the recording UI while the region-select overlay owns the bottom
            edge, and offline-only parks weather entirely. */}
          {weatherDockVisible && !drawing.active && weatherTl.timeline !== null && (
            <View style={styles.weatherDock} pointerEvents="box-none">
              {/* M2: the model sheet floats above the legend+scrubber in the
                same dock column (right-aligned over the chevron that opened
                it). Forecast layers only — radar is model-less. */}
              {modelSheetOpen && weatherTl.timeline.kind === 'forecast' && (
                <WeatherModelSheet
                  selected={weatherModel}
                  effective={effectiveModel}
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
                    ? // The EFFECTIVE model, with an honest marker when it was
                      // auto-resolved (outside the selected model's domain).
                      `${weatherModelById(effectiveModel).label} ${weatherModelById(effectiveModel).horizonLabel.toUpperCase()}${modelFallback ? ' · AUTO' : ''}`
                    : undefined
                }
              />
            </View>
          )}
        </View>

        {trailSheetUp && shownTrail !== null && (
          <ShownTrailSheet
            shown={shownTrail}
            position={location ? [location.longitude, location.latitude] : null}
            units={units}
            onLayout={(e) => setTrailSheetHeight(e.nativeEvent.layout.height)}
            onMessage={showSnack}
          />
        )}

        {inspectId && inspectPoints && inspectTrack && (
          <TrailInspectPanel
            track={inspectTrack}
            points={inspectPoints}
            units={units}
            onClose={() => {
              inspect(null);
              releaseCameraOnDeselect();
            }}
            onScrub={setMarkerAt}
            onView={() => router.push(`/trail3d/${inspectTrack.id}`)}
            // A drawn route reopens in the drawing tool, which closes this panel.
            onEditRoute={() =>
              useMapStore
                .getState()
                .setDrawRequest({ kind: 'edit-route', trackId: inspectTrack.id })
            }
            onLayout={setInspectPanelHeight}
          />
        )}

        {/* Night red veil (decision 4): tints the whole map; never catches touches. */}
        {displayCondition === 'night' && (
          <View
            style={[StyleSheet.absoluteFill, { backgroundColor: NIGHT_MAP.veil }]}
            pointerEvents="none"
          />
        )}

        {/* "Night on · tap to exit" (Night-Mode board), under the search pill. */}
        {displayCondition === 'night' && makeMapState === null && (
          <View
            style={[styles.topCenterChip, { top: insets.top + TOP_CHIP_OFFSET }]}
            pointerEvents="box-none"
          >
            <NightExitPill />
          </View>
        )}

        {/* Glove lock (revamp §3): a shield over the map and all its chrome;
          only the panel's hold-to-unlock stays live. */}
        {recordingPanelUp && gloveLocked && (
          <View
            style={StyleSheet.absoluteFill}
            onStartShouldSetResponder={() => true}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
          />
        )}

        {/* Recording panel (revamp decision 3): mini overlay / strip /
          expanded, full-width at the bottom — the tab bar hides while
          recording. Hidden while the region-select overlay owns the bottom. */}
        {recordingPanelUp && (
          <View style={styles.panelDock} pointerEvents="box-none">
            <RecordingPanel
              status={status === 'paused' ? 'paused' : 'recording'}
              stats={stats}
              elapsedS={elapsedS}
              liveSpeedMps={liveSpeedMps}
              gpsQuality={gpsQuality}
              onPause={pause}
              onResume={resume}
              onStop={() => {
                setGloveLocked(false);
                void handleStop();
              }}
              onMark={() => {
                const n = addWaypoint();
                if (n > 0) showSnack(`Waypoint ${n} dropped — tap it to add a note or photo`);
                else showSnack('Waiting for a GPS fix before dropping a waypoint');
              }}
              gloveLocked={gloveLocked}
              onGloveLockChange={setGloveLocked}
              onHeightChange={setPanelHeight}
            />
          </View>
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
              releaseCameraOnDeselect();
            }}
            topInset={insets.top}
          />
        )}

        {/* The coffee mascot's speech bubble (#476), over the tip button in the
          bottom-right corner: at the root so it can be tapped on Android, and
          above the whole bottom row so it never covers the scale bar or the
          credit caption. The bubble only shows with no panel or sheet up, so
          the column sits at the bottom edge. */}
        {bottomColumnH !== null && bottomRowY !== null && (
          <TipBubble
            right={TIP_BUBBLE_RIGHT}
            bottom={bottomColumnH - bottomRowY + TIP_BUBBLE_GAP}
            tailRight={TIP_BUBBLE_TAIL_RIGHT}
          />
        )}

        {/* The ⓘ credits sheet (2.1.1), just above the bottom row that holds the
          button. Its lines follow what the map is drawing right now. */}
        {creditsOpen && (
          <MapCreditsSheet
            lines={mapCredits({
              basemap: basemap === 'satellite' ? 'satellite' : 'map',
              vector: stoneBase,
              osmLabels: imageryLabels,
              terrain:
                (terrainContours && (vectorBasemap || imageryContours)) ||
                terrainOverlays2d.contours != null ||
                (showHillshade && basemap === 'map'),
              pdfMaps: shownMaps.map((m) => m.name),
              routingEngines: drawing.routingEngines,
              weather: weatherLayer !== null && !offlineOnly,
              marine: marineActive,
              geodetic: geodeticTiles !== null,
              tides: tideTiles !== null,
            })}
            bottom={
              // The bottom column's own lift, same precedence as its style.
              (drawing.panelHeight > 0
                ? drawing.panelHeight
                : trailSheetUp
                  ? trailSheetHeight
                  : recordingPanelUp
                    ? panelHeight
                    : 0) +
              (bottomColumnH !== null && bottomRowY !== null ? bottomColumnH - bottomRowY : 48) +
              TIP_BUBBLE_GAP
            }
            onClose={() => setCreditsOpen(false)}
          />
        )}

        {/* Category-first record start: sheet opens on "Record track"; Start
          actually begins the recording with the chosen category. */}
        <CategoryStartSheet
          visible={(pickingCategory || recordRequested) && status === 'idle' && !drawing.active}
          onStart={(categoryId) => {
            setPickingCategory(false);
            setRecordRequested(false);
            startRecording(categoryId);
          }}
          onDismiss={() => {
            setPickingCategory(false);
            setRecordRequested(false);
          }}
        />

        <BackgroundLocationRationale
          visible={bgRationaleVisible}
          onRespond={respondToBgRationale}
        />

        {/* Waypoint card (pin tap, #505): note/photo at a glance, Edit and
          hold-to-delete. Hidden while the trail inspector or the editor is up
          so the bottom edge never stacks two cards. Its dock floats above the
          recording panel (position AND z/elevation) — it used to be drawn
          under the panel while recording. */}
        {/* Drawing tools' chrome (#502/#503): mode chips + hint, the bottom
          panel, the save/edit sheets, and a tapped area's card. */}
        {drawing.chrome}

        {inspectTrack === null &&
          editWaypoint === null &&
          viewWaypoint !== null &&
          !drawing.active && (
            <View
              style={waypointCardDockStyle(recordingPanelUp, panelHeight)}
              pointerEvents="box-none"
              testID="waypoint-card-dock"
            >
              <WaypointViewerCard
                waypoint={viewWaypoint}
                floating={recordingPanelUp}
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
                  discardDraftPhoto(newWp);
                  setNewWp(null);
                  setEditWp(viewWp);
                  setWpName(viewWaypoint?.label ?? '');
                  setWpDraft(viewWaypoint?.note ?? '');
                  setViewWp(null);
                }}
                onDelete={deleteViewedWaypoint}
                onClose={() => setViewWp(null)}
              />
            </View>
          )}

        {/* Geodetic points: the tapped survey mark's summary card. Same
          bottom-card slot rules as the waypoint viewer. */}
        {geodeticTiles !== null &&
          geodeticMark !== null &&
          inspectTrack === null &&
          editWaypoint === null &&
          viewWaypoint === null &&
          !drawing.active && (
            <View
              style={waypointCardDockStyle(recordingPanelUp, panelHeight)}
              pointerEvents="box-none"
              testID="geodetic-card-dock"
              ref={geodeticDockRef}
              onLayout={() => {
                // The dock's own y is relative to its container, not the map:
                // measure both in window space and take the difference.
                const dock = geodeticDockRef.current;
                const area = mapAreaRef.current;
                if (!dock || !area || geodeticRecenterRef.current === null) return;
                area.measureInWindow((_ax, areaTop) => {
                  dock.measureInWindow((_dx, dockTop) => {
                    if (Number.isFinite(areaTop) && Number.isFinite(dockTop)) {
                      recenterOnGeodeticCard(dockTop - areaTop);
                    }
                  });
                });
              }}
            >
              <GeodeticPointCard
                mark={geodeticMark}
                floating={recordingPanelUp}
                offline={offlineOnly}
                onOpenLink={(url) => {
                  Linking.openURL(url).catch(() => showSnack("Couldn't open the datasheet"));
                }}
                onNavigate={() => {
                  setDestination({ latitude: geodeticMark.lat, longitude: geodeticMark.lng });
                  setGeodeticMark(null);
                }}
                onCopy={(text, what) => {
                  void Clipboard.setStringAsync(text);
                  showSnack(`Copied ${what}`);
                }}
                onClose={() => setGeodeticMark(null)}
              />
            </View>
          )}

        {/* Tide stations: the tapped station's card. Same bottom-card slot
          rules as the survey-mark card. */}
        {tideTiles !== null &&
          tideStation !== null &&
          inspectTrack === null &&
          editWaypoint === null &&
          viewWaypoint === null &&
          !drawing.active && (
            <View
              style={waypointCardDockStyle(recordingPanelUp, panelHeight)}
              pointerEvents="box-none"
              testID="tide-card-dock"
            >
              <TideStationCard
                station={tideStation}
                floating={recordingPanelUp}
                offline={offlineOnly}
                onOpenLink={(url) => {
                  Linking.openURL(url).catch(() => showSnack("Couldn't open the agency page"));
                }}
                onNavigate={() => {
                  setDestination({ latitude: tideStation.lat, longitude: tideStation.lng });
                  setTideStation(null);
                }}
                onCopy={(text) => {
                  void Clipboard.setStringAsync(text);
                  showSnack(`Copied: ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`);
                }}
                onClose={() => setTideStation(null)}
              />
            </View>
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

        {/* Coordinate readout + entry (#97): the map centre in all three
          notations (tap a line to copy), and a box that accepts decimal
          degrees, degrees-minutes or degrees-minutes-seconds. "Go" flies the
          camera; "Set destination" plants the pin — with the box empty that
          is the map centre, i.e. drop a pin on the crosshair. */}
        {goToOpen && (
          <GoToCoordinatesDialog
            center={goToCenter}
            initial={goToSeed}
            onDismiss={() => setGoToOpen(false)}
            onCopy={(text) => {
              void Clipboard.setStringAsync(text);
              showSnack('Coordinates copied');
            }}
            onGo={(at) => {
              setGoToOpen(false);
              flyToPoint(at);
              // Drop the readout chip on the target so the jump lands on
              // something visible rather than an unmarked patch of map.
              setPointAt(at);
            }}
            onSetDestination={(at) => {
              setGoToOpen(false);
              aimAt(at);
            }}
          />
        )}

        <WaypointEditorDialog
          waypoint={editWaypoint}
          name={wpName}
          onChangeName={setWpName}
          draft={wpDraft}
          onChangeDraft={setWpDraft}
          onSave={saveWaypoint}
          onDelete={deleteWaypoint}
          onSetPhoto={setWaypointPhoto}
          // Live recording pins take no icon (they end up as trail notes), so
          // the picker is simply not part of their editor.
          onSetIcon={editWp?.source === 'live' ? undefined : setWaypointIcon}
        />

        <Snackbar
          visible={snack !== null}
          onDismiss={dismissSnack}
          duration={Number.POSITIVE_INFINITY}
          wrapperStyle={snackbarWrapperStyle(recordingPanelUp, panelHeight)}
        >
          {snack ?? ''}
        </Snackbar>
        <Snackbar
          visible={overlaySnack !== null}
          onDismiss={dismissOverlaySnack}
          duration={Number.POSITIVE_INFINITY}
          wrapperStyle={snackbarWrapperStyle(recordingPanelUp, panelHeight)}
        >
          {overlaySnack ?? ''}
        </Snackbar>
        {downloadProgress !== null && (
          <Snackbar
            visible
            onDismiss={() => undefined}
            duration={Number.POSITIVE_INFINITY}
            wrapperStyle={snackbarWrapperStyle(recordingPanelUp, panelHeight)}
          >
            {`Downloading ${downloadProgress.label}… ${Math.floor(downloadProgress.pct)}%`}
          </Snackbar>
        )}
      </View>
    </MapAreaBottomContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Top-left instrument column: the compass badge alone since the scale bar
  // moved to the bottom-left corner — no gap left floating under it.
  topLeft: { position: 'absolute', left: 16, alignItems: 'flex-start' },
  // Between the compass (16 + 48) and the rail, with 12 dp either side.
  searchPill: { position: 'absolute', left: 76, right: 76 },
  // The open place search takes the whole top band, over compass and rail.
  searchSheet: { position: 'absolute', left: 12, right: 12, zIndex: 20 },
  // Centred under the search pill, between the compass and the rail.
  marineChip: { position: 'absolute', left: 76, right: 76, alignItems: 'center' },
  // Same lane, used by the destination readout (#97).
  topCenterChip: { position: 'absolute', left: 76, right: 76, alignItems: 'center', zIndex: 5 },
  banner: { position: 'absolute', left: 8, right: 8, borderRadius: 12 },
  bottom: { position: 'absolute', left: 16, right: 16, bottom: 0, gap: 12, paddingBottom: 10 },
  bottomRow: { flexDirection: 'row', alignItems: 'flex-end' },
  bottomSide: { flex: 1, alignItems: 'flex-start' },
  // ⓘ then the scale bar, one row, the ⓘ centred on the scale bar's height (owner).
  bottomSideStart: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bottomSideEnd: { alignItems: 'flex-end' },
  panelDock: { position: 'absolute', left: 0, right: 0, bottom: 0, ...BOTTOM_LAYER.recordingPanel },
  // Legend pill + time scrubber, tight together (the bottom column's own gap
  // is for separating whole blocks like the recording bar).
  weatherDock: { gap: 6 },
});
