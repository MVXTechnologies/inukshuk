import { MAP_MAX_PITCH_DEG } from '@core/map/tiltRelief';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface NativeMapPitchModule {
  /** Sets the max pitch on every loaded MapLibre map on screen; returns how many. */
  setMaxPitch(degrees: number): Promise<number>;
}

function nativeModule(): NativeMapPitchModule | null {
  return Platform.OS === 'android' || Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativeMapPitchModule>('InukshukMapPitch')
    : null;
}

/**
 * Lets the maps on screen tilt to {@link MAP_MAX_PITCH_DEG} (#480) — call it
 * from a <Map>'s onDidFinishLoadingMap. The local `InukshukMapPitch` module
 * (`modules/inukshuk-map-pitch`) sets it natively, since the MapLibre RN
 * wrapper has no prop for it. OPTIONAL: on a binary without the module (any
 * build before 2.0.2 running this JS over the air) it does nothing and the
 * maps keep MapLibre's 60°. Never throws; resolves to the number of maps set.
 */
export async function raiseMapMaxPitch(): Promise<number> {
  const module = nativeModule();
  if (!module) return 0;
  try {
    return await module.setMaxPitch(MAP_MAX_PITCH_DEG);
  } catch {
    return 0; // mid-teardown or a platform surprise: the map just stays at 60°
  }
}
