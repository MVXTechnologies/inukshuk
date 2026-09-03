import { type Units } from '@core/format';
import { sanitizeLastKnownPosition } from '@core/geo/lastKnownPosition';
import { DEFAULT_CATEGORY_ID } from '@core/library/categories';
import { SETTINGS_SCHEMA_VERSION, migrateSettings } from '@core/library/migrations';
import type { LatLng } from '@core/models';
import * as storage from '@data/storage';
import type { UiStyle } from '@ui/theme';
import { sanitizeMarineLayers, type MarineLayerId } from '@core/geo/marineLayers';
import { sanitizeMarinePackSnoozes } from '@core/geo/marinePacks';
import { sanitizeTrailNetworks, type TrailNetworkId } from '@core/geo/trailNetworks';
import { sanitizeWeatherLayer, type WeatherLayerId } from '@core/geo/weatherLayers';
import {
  DEFAULT_WEATHER_MODEL,
  sanitizeWeatherModel,
  type WeatherModelId,
} from '@core/weather/weatherModels';
import { create } from 'zustand';

const SETTINGS_FILE = 'settings.json';

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
  /** Trail detail view: real 3D terrain or a flat 2D map. */
  trailViewMode: '2d' | '3d';
  /** Use only offline maps; don't fetch from OSM. */
  offlineOnly: boolean;
  /** Display units for distances, elevation, speed and pace. */
  units: Units;
  /** App theme: follow the OS ('system') or force light/dark. */
  themeMode: 'system' | 'light' | 'dark';
  /** Visual identity: classic brand look, quiet minimal, or the pastel edge style. */
  uiStyle: UiStyle;
  /** Checked marked-trail databases draped on the main map (empty = off). */
  markedTrailsNetworks: TrailNetworkId[];
  /**
   * Active ECCC GeoMet weather overlay (radar / wind / precip), or null = off.
   * Network-only: the map drops it entirely while `offlineOnly` is on, the
   * same way `markedTrailsNetworks` is dropped.
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
   * Last known map position, used to seed the camera on a cold launch so the
   * map opens where the user last was instead of MapLibre's [0,0] default
   * ("null island") while waiting for the first GPS fix. `null` = never saved
   * (migration-safe: files written before this field existed hydrate to null).
   * Written cheaply — on backgrounding and at most once per minute of fixes
   * (see `useLocationTracking`) — never per-fix.
   */
  lastKnownPosition: LatLng | null;
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
  uiStyle: 'classic',
  markedTrailsNetworks: [],
  weatherLayer: null,
  weatherModel: DEFAULT_WEATHER_MODEL,
  windParticles: true,
  marineLayers: [],
  marinePackAutoUpdate: true,
  marinePackSnoozes: [],
  showHeatmap: true,
  errorReporting: true,
  terrainSlope: false,
  terrainContours: false,
  terrainHypso: false,
  terrainContourIntervalM: 0,
  terrainSlopeMinDeg: 27,
  terrainSlopeMaxDeg: 90,
  slopeDisclaimerShown: false,
  lastActivityCategory: DEFAULT_CATEGORY_ID,
  lastKnownPosition: null,
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
    uiStyle,
    markedTrailsNetworks,
    weatherLayer,
    weatherModel,
    windParticles,
    marineLayers,
    marinePackAutoUpdate,
    marinePackSnoozes,
    showHeatmap,
    errorReporting,
    terrainSlope,
    terrainContours,
    terrainHypso,
    terrainContourIntervalM,
    terrainSlopeMinDeg,
    terrainSlopeMaxDeg,
    slopeDisclaimerShown,
    lastActivityCategory,
    lastKnownPosition,
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
    uiStyle,
    markedTrailsNetworks,
    weatherLayer,
    weatherModel,
    windParticles,
    marineLayers,
    marinePackAutoUpdate,
    marinePackSnoozes,
    showHeatmap,
    errorReporting,
    terrainSlope,
    terrainContours,
    terrainHypso,
    terrainContourIntervalM,
    terrainSlopeMinDeg,
    terrainSlopeMaxDeg,
    slopeDisclaimerShown,
    lastActivityCategory,
    lastKnownPosition,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,

  hydrate: async () => {
    const saved = await storage.readJson<unknown>(SETTINGS_FILE);
    // Migration ladder: legacy unversioned files merge over DEFAULTS; junk
    // fields and wrong-typed values are dropped instead of crashing hydration.
    const next = migrateSettings(saved, DEFAULTS);
    // migrateSettings only checks `typeof` against the default; with a `null`
    // default any object-typed junk would slip through — deep-validate here.
    next.lastKnownPosition = sanitizeLastKnownPosition(next.lastKnownPosition);
    next.markedTrailsNetworks = sanitizeTrailNetworks(next.markedTrailsNetworks);
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
    set({ ...next, hydrated: true });
  },

  set: (key, value) => {
    // A no-op write still notifies every subscriber AND rewrites settings.json
    // synchronously (persist → storage.writeJson stages, writes, deletes and
    // moves a file on the JS thread). Re-setting the value a toggle already
    // holds is common — bail before paying for it.
    if (Object.is(get()[key], value)) return;
    set({ [key]: value } as Pick<Settings, typeof key>);
    const next = snapshot(get());
    persist(next);
  },

  reset: () => {
    set({ ...DEFAULTS });
    persist(DEFAULTS);
  },
}));
