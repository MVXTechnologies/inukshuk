/**
 * The JS face of the native 3D terrain module (modules/inukshuk-terrain,
 * docs/plans/native-terrain.md). Optional: binaries built before the module
 * existed (an OTA'd bundle on an older store build) get `null` and the map
 * keeps its 2D tilt relief. Nothing here runs per frame — JS only attaches,
 * pushes a new look when the theme/setting changes, and detaches.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { TerrainLineSpec } from '@core/terrain3d/sceneInput';

export interface NativeTerrainConfig {
  /** `packLook()` floats (@core/terrain3d/look). */
  look: number[];
  /** false = attached as a frame-timing probe only (QA 2D baseline). */
  enabled: boolean;
  networkAllowed: boolean;
  maxPitch: number;
  /** Pin plates: plate rgba, ink rgb, muted rgb, water rgb (packLabelTheme). */
  labelTheme: number[];
  /** Name properties to try, in order. */
  nameFields: string[];
  /** Draw the 3D pin labels. */
  labels: boolean;
  /** UI bands (logical px) the pins stay clear of: [top (search/status bar), bottom bar]. */
  labelInsets: number[];
}

export type { TerrainLineSpec as NativeTerrainLine } from '@core/terrain3d/sceneInput';

export interface NativeBenchStep {
  kind:
    | 'idle'
    | 'pitch'
    | 'rotate'
    | 'pan'
    | 'fling'
    | 'zoom'
    | 'tiltnoisy'
    | 'rotatenoisy'
    | 'pinchnoisy';
  durationMs: number;
  amount: number;
}

export interface NativeBenchResult {
  frameTimesNs: number[];
  costNs: number[];
  stats: number[];
}

interface NativeTerrainModule {
  supported: boolean;
  attach(viewTag: number, config: NativeTerrainConfig): Promise<boolean>;
  update(viewTag: number, config: NativeTerrainConfig): void;
  /** Replaces the whole set of lines lifted onto the terrain. */
  setLines?(viewTag: number, lines: TerrainLineSpec[]): void;
  setPuck?(viewTag: number, visible: boolean, lng: number, lat: number): void;
  /**
   * The style (JSON) the terrain drapes per tile — the 2D map without its
   * names (@core/terrain3d/drapeStyle); '' = no drape (the shaded model).
   */
  setDrapeStyle?(viewTag: number, json: string): void;
  detach(viewTag: number): Promise<void>;
  stats(viewTag: number): Promise<number[]>;
  trimMemory(viewTag: number): Promise<void>;
  setPitch(viewTag: number, deg: number): Promise<void>;
  /** Animate the pitch (past MapLibre's JS 60° clamp while 3D is attached). */
  animatePitch?(viewTag: number, deg: number, durationMs: number): Promise<void>;
  /** QA: the whole camera in one native move (iOS). */
  jumpTo?(
    viewTag: number,
    lat: number,
    lng: number,
    zoom: number,
    pitch: number,
    bearing: number,
  ): Promise<void>;
  runBench(viewTag: number, script: NativeBenchStep[]): Promise<NativeBenchResult | null>;
  record(
    viewTag: number,
    on: boolean,
  ): Promise<{ frameTimesNs: number[]; costNs: number[] } | null>;
}

let cached: NativeTerrainModule | null | undefined;

export function nativeTerrain(): NativeTerrainModule | null {
  if (cached !== undefined) return cached;
  cached =
    Platform.OS === 'android' || Platform.OS === 'ios'
      ? requireOptionalNativeModule<NativeTerrainModule>('InukshukTerrain')
      : null;
  return cached;
}

/** True when this binary ships the native terrain. */
export function nativeTerrainAvailable(): boolean {
  return nativeTerrain()?.supported === true;
}

/** Stats array → named fields (order: TerrainNative.nativeStats / the iOS twin). */
export function namedTerrainStats(s: readonly number[]): Record<string, number> {
  const names = [
    'demCount',
    'demBytes',
    'meshCount',
    'drawnTiles',
    'flatTiles',
    'inFlight',
    'requested',
    'failed',
    'engineCpuMs',
    'drawMs',
    'pitchDeg',
    'gpuTileSlots',
    'labelsShown',
    'imagerySlots',
    'bakeQueue',
    // round 3: stability and cache counters (cumulative unless noted)
    'hRef',
    'hRefTravelM',
    'morphs',
    'maxMorphM',
    'meshBakes',
    'imageryUploads',
    'drapeRenders',
    'drapeDiskHits',
    'demDisk',
    'demNetwork',
    // two-finger gestures classified (cumulative)
    'gestureTilt',
    'gestureRotate',
    'gesturePinch',
    'gesturePan',
    'labelToggles',
    // Android only: the camera when sampled
    'camBearing',
    'camZoom',
    'camTilt',
  ];
  const out: Record<string, number> = {};
  names.forEach((n, i) => {
    const v = s[i];
    if (typeof v === 'number') out[n] = v;
  });
  return out;
}
