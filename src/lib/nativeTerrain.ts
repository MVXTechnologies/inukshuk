/**
 * The JS face of the native 3D terrain module (modules/inukshuk-terrain,
 * docs/plans/native-terrain.md). Optional: binaries built before the module
 * existed (an OTA'd bundle on an older store build) get `null` and the map
 * keeps its 2D tilt relief. Nothing here runs per frame — JS only attaches,
 * pushes a new look when the theme/setting changes, and detaches.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface NativeTerrainConfig {
  /** `packLook()` floats (@core/terrain3d/look). */
  look: number[];
  /** false = attached as a frame-timing probe only (QA 2D baseline). */
  enabled: boolean;
  networkAllowed: boolean;
  maxPitch: number;
}

export interface NativeBenchStep {
  kind: 'idle' | 'pitch' | 'rotate' | 'pan' | 'fling';
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
  detach(viewTag: number): Promise<void>;
  stats(viewTag: number): Promise<number[]>;
  trimMemory(viewTag: number): Promise<void>;
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
    'gpuTileBuffers',
  ];
  const out: Record<string, number> = {};
  names.forEach((n, i) => {
    const v = s[i];
    if (typeof v === 'number') out[n] = v;
  });
  return out;
}
