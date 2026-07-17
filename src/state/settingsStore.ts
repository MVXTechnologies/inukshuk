import { DEFAULT_CATEGORY_ID } from '@core/library/categories';
import { SETTINGS_SCHEMA_VERSION, migrateSettings } from '@core/library/migrations';
import * as storage from '@data/storage';
import { setDisplayUnits, type Units } from '@lib/format';
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
  /** Whether the one-time "slope shading is indicative" disclaimer was shown. */
  slopeDisclaimerShown: boolean;
  /** Last activity category picked at record start (the picker's default). */
  lastActivityCategory: string;
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
  errorReporting: true,
  terrainSlope: false,
  terrainContours: false,
  terrainHypso: false,
  terrainContourIntervalM: 0,
  slopeDisclaimerShown: false,
  lastActivityCategory: DEFAULT_CATEGORY_ID,
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
    errorReporting,
    terrainSlope,
    terrainContours,
    terrainHypso,
    terrainContourIntervalM,
    slopeDisclaimerShown,
    lastActivityCategory,
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
    errorReporting,
    terrainSlope,
    terrainContours,
    terrainHypso,
    terrainContourIntervalM,
    slopeDisclaimerShown,
    lastActivityCategory,
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
    setDisplayUnits(next.units);
    set({ ...next, hydrated: true });
  },

  set: (key, value) => {
    set({ [key]: value } as Pick<Settings, typeof key>);
    const next = snapshot(get());
    setDisplayUnits(next.units);
    persist(next);
  },

  reset: () => {
    setDisplayUnits(DEFAULTS.units);
    set({ ...DEFAULTS });
    persist(DEFAULTS);
  },
}));
