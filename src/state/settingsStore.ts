import { type Units } from '@core/format';
import { isDisplayCondition, type DisplayCondition } from '@core/display/condition';
import { sanitizeLastKnownPosition } from '@core/geo/lastKnownPosition';
import { DEFAULT_CATEGORY_ID } from '@core/library/categories';
import { SETTINGS_SCHEMA_VERSION, migrateSettings } from '@core/library/migrations';
import { DEFAULT_SORT, isSortKey, type SortKey } from '@core/library/sortTracks';
import type { LatLng } from '@core/models';
import * as storage from '@data/storage';
import { sanitizeMarineLayers, type MarineLayerId } from '@core/geo/marineLayers';
import {
  DEFAULT_HILLSHADE_STRENGTH,
  DEFAULT_PEAK_DENSITY,
  isHillshadeStrength,
  isPeakDensity,
  type HillshadeStrength,
  type PeakDensity,
} from '@core/map/terrainOptions';
import { DEFAULT_WHITE_KEY, isWhiteKeyLevel, type WhiteKeyLevel } from '@core/geo/pdfWhiteKey';
import { DEFAULT_TILT_RELIEF, isTiltRelief, type TiltRelief } from '@core/map/tiltRelief';
import { DEFAULT_IMAGERY_LOOK, isImageryLook, type ImageryLook } from '@core/map/satelliteImagery';
import { sanitizeMarinePackSnoozes } from '@core/geo/marinePacks';
import { sanitizeWeatherLayer, type WeatherLayerId } from '@core/geo/weatherLayers';
import {
  DEFAULT_WEATHER_MODEL,
  sanitizeWeatherModel,
  type WeatherModelId,
} from '@core/weather/weatherModels';
import { Platform } from 'react-native';
import { create } from 'zustand';

const SETTINGS_FILE = 'settings.json';

/**
 * TEMPORARY per-platform default for the shaded-relief hillshade (#230), and
 * the ONLY place that decision is made.
 *
 * Field report on 1.5.0 build 5: on a current iPhone the `map` and `relief`
 * basemaps skip frames when zooming out while `satellite` — the one basemap
 * with no hillshade — stays smooth; not reproducible on Android with the same
 * build. The under-map hillshade is the only render-path difference, so iOS
 * opens with it OFF until the owner can A/B it on the device (see
 * `docs/plans/ios-hillshade-230.md`). Android keeps it ON: the shading looks
 * good there and costs nothing measurable.
 *
 * This is a mitigation, not a diagnosis. The zoom gate and the 512-px DEM
 * declaration in `mapStyle.ts` are the real fix and apply on both platforms;
 * once a device A/B shows they are enough, flip this back to a plain `true`
 * and keep the switch.
 */
export const DEFAULT_SHOW_HILLSHADE = Platform.OS !== 'ios';

/**
 * The default OpenStreetMap raster tile endpoint. NOTE: the public OSM tile
 * servers have a usage policy that forbids heavy traffic. For a widely
 * distributed app, point this at your own raster cache or a free provider
 * (e.g. a self-hosted tileserver-gl, or Protomaps basemaps). Configurable here
 * so swapping the basemap never requires a code change.
 */
export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * Visual style for the elevation profile chart: 'gradient' = elevation area fill,
 * 'pace' = line coloured by speed at each point. '3d' is a future feature.
 */
export type ElevationProfileStyle = 'gradient' | 'pace';

export interface Settings {
  tileUrl: string;
  /** Keep the screen awake while recording a trail. */
  keepAwakeWhileRecording: boolean;
  /** Rotate the map to match the device heading. */
  rotateMapWithHeading: boolean;
  /** Minimum metres between recorded GPS fixes (noise/density control). */
  minDisplacementM: number;
  /** Preferred elevation-profile chart style. */
  elevationProfileStyle: ElevationProfileStyle;
  /**
   * Trail detail view: real 3D terrain or a flat 2D map. DORMANT since #480:
   * the focused view is always the 2D map (two-finger tilt), and nothing
   * reads this — kept so settings files round-trip and the three.js view can
   * come back without a migration.
   */
  trailViewMode: '2d' | '3d';
  /** Use only offline maps; don't fetch from OSM. */
  offlineOnly: boolean;
  /** Display units for distances, elevation, speed and pace. */
  units: Units;
  /** App theme: follow the OS ('system') or force light/dark. */
  themeMode: 'system' | 'light' | 'dark';
  /**
   * Fold the map's right-hand controls behind one chevron until asked (the
   * old Minimal style's rail, kept as a toggle when the styles were retired).
   */
  compactMapChrome: boolean;
  /**
   * Display mode the user chose (decision 4): Normal by default; Sunlight and
   * Night red are opt-in. The mode in effect also depends on the toggles.
   */
  displayCondition: DisplayCondition;
  /** Switch to Night red after sunset (until sunrise). */
  autoNightAtSunset: boolean;
  /** Switch to Sunlight while a recording is running. */
  sunlightWhileRecording: boolean;
  /**
   * Active ECCC GeoMet weather overlay (radar / wind / precip), or null = off.
   * Network-only: the map drops it entirely while `offlineOnly` is on.
   */
  weatherLayer: WeatherLayerId | null;
  /**
   * Forecast model the forecast drapes resolve against (weather UX M2):
   * HRDPS 2.5 km / RDPS 10 km / GDPS 15 km. Radar layers ignore it. Never
   * null — junk hydrates back to the HRDPS default.
   */
  weatherModel: WeatherModelId;
  /**
   * Windy-style animated wind streaks over the Wind weather layer (M3).
   * The whole GL particle overlay hangs off this one flag so QA (or a
   * device that hates it) can kill it — off = the gradient drape alone,
   * exactly the pre-M3 wind UX.
   */
  windParticles: boolean;
  /**
   * Checked marine reference layers (NONNA bathymetry / seamarks; empty =
   * off). Network-only like the trail networks — dropped from the style
   * while `offlineOnly` is on. Any active layer also shows the mandatory
   * "Not for navigation" chip on the map.
   */
  marineLayers: MarineLayerId[];
  /**
   * Refresh offline marine packs older than 30 days when the app comes to
   * the foreground online (marine wave D §D4). NOTE: the app carries no
   * network-type native module by design (it must stay OTA-able), so this
   * cannot be Wi-Fi-only — packs are a few megabytes each and the sweep only
   * runs monthly, which is why the honest label says "when online".
   */
  marinePackAutoUpdate: boolean;
  /**
   * Regions where the pack offer was waved off, as `"<cellKey>@<expiryMs>"`
   * strings (see `@core/geo/marinePacks`). The banner must never nag.
   */
  marinePackSnoozes: string[];
  /** Native MapLibre heatmap density layer under the trail lines. */
  showHeatmap: boolean;
  /**
   * The "PDF maps" master switch (overlays menu → Topology): whether the
   * imported/made PDF maps are drawn at all. Off targets nothing — no page
   * is rasterized and the Library card reports nothing — whatever the
   * folder picker says (`@core/library/visibility` → `pdfOverlayMaps`).
   * Persisted, unlike the map's transient view flags: a hidden-maps choice
   * has to survive a restart (#233 — the row was lost in the #201 menu
   * rework and the flag sat unreachable, always on, in the in-memory map
   * store).
   */
  showPdfOverlay: boolean;
  /**
   * "See-through white" (overlays menu → On the map, under PDF maps): how
   * transparent the near-white paper of every PDF map is drawn, so the base
   * map shows through open land and the collar (`@core/geo/pdfWhiteKey`).
   * The global default; a map can override it from its Library ⋮ menu
   * (`MapDocument.whiteKey`). Off by default — no change until chosen.
   */
  pdfWhiteKey: WhiteKeyLevel;
  /**
   * Latitude-aware scale bar under the compass badge. On by default — a map
   * you navigate by needs a distance reference — but switchable, because map
   * chrome has been pruned here before for clutter.
   */
  showScaleBar: boolean;
  /**
   * "Labels on satellite" (overlays menu → On the map, #484): while the base
   * map is Satellite, draw our vector map's roads, trails and names over the
   * imagery. No effect on the Map base, which carries its own.
   */
  satelliteLabels: boolean;
  /**
   * "Imagery" (overlays menu → On the map, #495): how the Satellite base map
   * is toned — the tiles as served, or a brightening paint over them.
   */
  satelliteImagery: ImageryLook;
  /**
   * Shaded-relief hillshade blended under the `map` basemap (the
   * `hillshade-2d` layer in `mapStyle.ts`). Platform-defaulted — see
   * {@link DEFAULT_SHOW_HILLSHADE} and #230.
   */
  showHillshade: boolean;
  /**
   * How strong the shaded relief is when {@link showHillshade} is on (#461).
   * The map menu's "Shading: None / Light / Medium / Heavy" is the pair:
   * None = showHillshade off, so the #230 platform default keeps working.
   */
  hillshadeStrength: HillshadeStrength;
  /** How early named summits appear on the vector map (#461). */
  peakDensity: PeakDensity;
  /**
   * How much the shaded relief deepens when the map is tilted (#480) — the
   * Topology menu's "3D relief" row. Rides on the hillshade: with Shading
   * None there is nothing to deepen.
   */
  tiltRelief: TiltRelief;
  /** Automatically report app errors as GitHub issues (see src/lib/errorReporting). */
  errorReporting: boolean;
  /** 3D terrain: CalTopo-style slope-angle shading overlay. */
  terrainSlope: boolean;
  /** 3D terrain: contour lines overlay. */
  terrainContours: boolean;
  /** 3D terrain: hypsometric elevation-tint bands overlay. */
  terrainHypso: boolean;
  /** 3D terrain: minor contour interval in metres; 0 = auto (span-based). */
  terrainContourIntervalM: number;
  /**
   * Slope overlay window, in degrees (2D raster and 3D shader): only slopes
   * within [min, max] are painted. 27–90 = every CalTopo band (default look).
   */
  terrainSlopeMinDeg: number;
  terrainSlopeMaxDeg: number;
  /** Whether the one-time "slope shading is indicative" disclaimer was shown. */
  slopeDisclaimerShown: boolean;
  /** Last activity category picked at record start (the picker's default). */
  lastActivityCategory: string;
  /**
   * Trail ordering picked in the Library's "Filter & sort" panel (see
   * `@core/library/sortTracks`). A *preference*, not a query: the filter
   * itself is deliberately session-only — reopening the app to a list
   * silently hiding most of the library would be a bug report — but "I read
   * my trails longest-first" should still hold tomorrow, so this one is
   * persisted. Junk hydrates back to the default via `isSortKey`.
   */
  librarySortKey: SortKey;
  /**
   * Last known map position, used to seed the camera on a cold launch so the
   * map opens where the user last was instead of MapLibre's [0,0] default
   * ("null island") while waiting for the first GPS fix. `null` = never saved
   * (migration-safe: files written before this field existed hydrate to null).
   * Written cheaply — on backgrounding and at most once per minute of fixes
   * (see `useLocationTracking`) — never per-fix.
   */
  lastKnownPosition: LatLng | null;
  /**
   * When the Library's once-a-year support card was last answered (Support or
   * Not now), epoch ms; 0 = never. Read only while `SUPPORT_NUDGE_ENABLED` is
   * on (see `@core/support/nudge`).
   */
  supportNudgeAnsweredAt: number;
  /** The floating tip-jar button on the main tabs (#476; Settings › App settings, or long-press › Hide). */
  showTipJar: boolean;
  /**
   * Epoch ms until which the tip button rests (12 months after a tip in the
   * app or a verified "I already donated"); 0 = not resting. It comes back after.
   */
  tipJarRestingUntil: number;
}

const DEFAULTS: Settings = {
  tileUrl: DEFAULT_TILE_URL,
  keepAwakeWhileRecording: true,
  rotateMapWithHeading: false,
  minDisplacementM: 5,
  elevationProfileStyle: 'gradient',
  trailViewMode: '3d',
  offlineOnly: false,
  units: 'metric',
  themeMode: 'system',
  compactMapChrome: false,
  displayCondition: 'normal',
  autoNightAtSunset: false,
  sunlightWhileRecording: false,
  weatherLayer: null,
  weatherModel: DEFAULT_WEATHER_MODEL,
  windParticles: true,
  marineLayers: [],
  marinePackAutoUpdate: true,
  marinePackSnoozes: [],
  showHeatmap: true,
  showPdfOverlay: true,
  pdfWhiteKey: DEFAULT_WHITE_KEY,
  showScaleBar: true,
  satelliteLabels: true,
  satelliteImagery: DEFAULT_IMAGERY_LOOK,
  showHillshade: DEFAULT_SHOW_HILLSHADE,
  hillshadeStrength: DEFAULT_HILLSHADE_STRENGTH,
  peakDensity: DEFAULT_PEAK_DENSITY,
  tiltRelief: DEFAULT_TILT_RELIEF,
  errorReporting: true,
  terrainSlope: false,
  terrainContours: false,
  terrainHypso: false,
  terrainContourIntervalM: 0,
  terrainSlopeMinDeg: 27,
  terrainSlopeMaxDeg: 90,
  slopeDisclaimerShown: false,
  lastActivityCategory: DEFAULT_CATEGORY_ID,
  librarySortKey: DEFAULT_SORT,
  lastKnownPosition: null,
  supportNudgeAnsweredAt: 0,
  showTipJar: true,
  tipJarRestingUntil: 0,
};

interface SettingsState extends Settings {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

function persist(s: Settings): void {
  storage.writeJson(SETTINGS_FILE, { schemaVersion: SETTINGS_SCHEMA_VERSION, ...s });
}

/**
 * Keys written before hydration, waiting to be laid over what is on disk.
 *
 * Until settings.json has been read, the store holds DEFAULTS, and `set`
 * persists the WHOLE snapshot — so one early write used to overwrite every
 * saved setting with its default, the error-reporting opt-out included. The
 * guard lived in one caller (useLocation); now it lives here. Early writes
 * are not refused: every caller is a user gesture (a switch, a sort pick)
 * whose new value is already on screen, and dropping it would make the
 * control snap back for no visible reason. They are applied in memory and
 * remembered by key; `hydrate` keeps them over the file's values — they are
 * the user's newest word for those keys, and only those — and writes once.
 */
const pendingWrites = new Set<keyof Settings>();

// Single-flight, like the library's: a foreground retry that races the
// launch read must not land a second, older snapshot over the first.
let hydration: Promise<void> | null = null;

/** Pick just the persisted Settings fields out of the full store state. */
function snapshot(s: SettingsState): Settings {
  const {
    tileUrl,
    keepAwakeWhileRecording,
    rotateMapWithHeading,
    minDisplacementM,
    elevationProfileStyle,
    trailViewMode,
    offlineOnly,
    units,
    themeMode,
    compactMapChrome,
    displayCondition,
    autoNightAtSunset,
    sunlightWhileRecording,
    weatherLayer,
    weatherModel,
    windParticles,
    marineLayers,
    marinePackAutoUpdate,
    marinePackSnoozes,
    showHeatmap,
    showPdfOverlay,
    pdfWhiteKey,
    showScaleBar,
    satelliteLabels,
    satelliteImagery,
    showHillshade,
    hillshadeStrength,
    peakDensity,
    tiltRelief,
    errorReporting,
    terrainSlope,
    terrainContours,
    terrainHypso,
    terrainContourIntervalM,
    terrainSlopeMinDeg,
    terrainSlopeMaxDeg,
    slopeDisclaimerShown,
    lastActivityCategory,
    librarySortKey,
    lastKnownPosition,
    supportNudgeAnsweredAt,
    showTipJar,
    tipJarRestingUntil,
  } = s;
  return {
    tileUrl,
    keepAwakeWhileRecording,
    rotateMapWithHeading,
    minDisplacementM,
    elevationProfileStyle,
    trailViewMode,
    offlineOnly,
    units,
    themeMode,
    compactMapChrome,
    displayCondition,
    autoNightAtSunset,
    sunlightWhileRecording,
    weatherLayer,
    weatherModel,
    windParticles,
    marineLayers,
    marinePackAutoUpdate,
    marinePackSnoozes,
    showHeatmap,
    showPdfOverlay,
    pdfWhiteKey,
    showScaleBar,
    satelliteLabels,
    satelliteImagery,
    showHillshade,
    hillshadeStrength,
    peakDensity,
    tiltRelief,
    errorReporting,
    terrainSlope,
    terrainContours,
    terrainHypso,
    terrainContourIntervalM,
    terrainSlopeMinDeg,
    terrainSlopeMaxDeg,
    slopeDisclaimerShown,
    lastActivityCategory,
    librarySortKey,
    lastKnownPosition,
    supportNudgeAnsweredAt,
    showTipJar,
    tipJarRestingUntil,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  hydrate: () => {
    hydration ??= (async () => {
      const saved = await storage.readJson<unknown>(SETTINGS_FILE);
      // Migration ladder: legacy unversioned files merge over DEFAULTS; junk
      // fields and wrong-typed values are dropped instead of crashing hydration.
      const next = migrateSettings(saved, DEFAULTS);
      // migrateSettings only checks `typeof` against the default; with a `null`
      // default any object-typed junk would slip through — deep-validate here.
      next.lastKnownPosition = sanitizeLastKnownPosition(next.lastKnownPosition);
      // `markedTrailsNetworks` (the retired Waymarked Trails overlay, #467) is
      // not a Settings key any more: the ladder copies only known keys, so an
      // old file's value is dropped here and gone at the next write.
      next.marineLayers = sanitizeMarineLayers(next.marineLayers);
      next.marinePackSnoozes = sanitizeMarinePackSnoozes(next.marinePackSnoozes, Date.now());
      // weatherLayer's default is null (typeof 'object'), so the migration
      // ladder's typeof check DROPS a valid persisted string id (and would pass
      // object junk through). Recover the raw value and deep-validate it.
      next.weatherLayer = sanitizeWeatherLayer(
        typeof saved === 'object' && saved !== null
          ? (saved as { weatherLayer?: unknown }).weatherLayer
          : null,
      );
      // weatherModel's default is a string, so the ladder keeps any string —
      // including junk ids from older builds. Deep-validate to the catalog.
      next.weatherModel = sanitizeWeatherModel(next.weatherModel);
      // Same story for the Library sort: the ladder keeps any string, so a key
      // retired by a later build would survive as an unmatched switch case.
      if (!isSortKey(next.librarySortKey)) next.librarySortKey = DEFAULT_SORT;
      if (!isDisplayCondition(next.displayCondition)) next.displayCondition = 'normal';
      if (!isHillshadeStrength(next.hillshadeStrength)) {
        next.hillshadeStrength = DEFAULT_HILLSHADE_STRENGTH;
      }
      if (!isPeakDensity(next.peakDensity)) next.peakDensity = DEFAULT_PEAK_DENSITY;
      if (!isTiltRelief(next.tiltRelief)) next.tiltRelief = DEFAULT_TILT_RELIEF;
      if (!isImageryLook(next.satelliteImagery)) next.satelliteImagery = DEFAULT_IMAGERY_LOOK;
      if (!isWhiteKeyLevel(next.pdfWhiteKey)) next.pdfWhiteKey = DEFAULT_WHITE_KEY;
      // Writes that landed before the file was read win for their own keys.
      const current = get();
      const early: Partial<Settings> = {};
      for (const key of pendingWrites) Object.assign(early, { [key]: current[key] });
      set({ ...next, ...early, hydrated: true });
      if (pendingWrites.size > 0) {
        pendingWrites.clear();
        // One write for all of them. Should it fail, the store is hydrated and
        // the values are in memory, so the next `set` writes them again; the
        // error reaches hydrate()'s caller, which reports it.
        persist(snapshot(get()));
      }
    })().finally(() => {
      hydration = null;
    });
    return hydration;
  },

  set: (key, value) => {
    // A no-op write still notifies every subscriber AND rewrites settings.json
    // synchronously (persist → storage.writeJson stages, writes, deletes and
    // moves a file on the JS thread). Re-setting the value a toggle already
    // holds is common — bail before paying for it.
    if (Object.is(get()[key], value)) return;
    set({ [key]: value } as Pick<Settings, typeof key>);
    if (!get().hydrated) {
      // Not read yet: never write DEFAULTS over the file (see pendingWrites).
      pendingWrites.add(key);
      return;
    }
    const next = snapshot(get());
    persist(next);
  },

  reset: () => {
    set({ ...DEFAULTS });
    if (!get().hydrated) {
      for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) pendingWrites.add(key);
      return;
    }
    persist(DEFAULTS);
  },
}));
