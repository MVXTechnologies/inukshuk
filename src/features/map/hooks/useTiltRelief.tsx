import { pitchBucket, tiltReliefExaggeration } from '@core/map/tiltRelief';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { tiltReliefLayer } from '../mapLayers';
import { styleHasTiltRelief } from '../mapStyle';

export interface TiltReliefBinding {
  /** Wire to the <Map>'s onDidFinishLoadingStyle. */
  onStyleLoaded: () => void;
  /** Feed every SETTLED camera pitch (onRegionDidChange / first view state). */
  onSettledPitch: (pitchDeg: number) => void;
  /** The <Map> child driving the style's pass, or null when there is none. */
  layer: ReactNode;
}

/**
 * The tilted-map relief pass (#480), shared by the main map and the focused
 * trail view: the style (built with `tiltRelief`) carries the pass hidden;
 * the caller passes the setting to the builder itself (the style comes
 * first). This keeps the settled pitch and renders the component layer that switches
 * it on with the right exaggeration.
 *
 * Settle-driven, never at gesture rate: the pitch lives in React state in 5°
 * steps, so a follow-mode settle per GPS fix (same pitch) re-renders nothing.
 *
 * The layer is KEYED on the style-load count. A style change re-adds only the
 * component SOURCES and their layers (MLRNMapView.setReactMapStyle ->
 * addAllSourcesToMap); a free-standing component <Layer> would keep a
 * reference to the old style's layer and silently drive nothing (found on the
 * emulator). Re-mounting after each load makes it adopt the new style's
 * layer, and not mounting before the first load keeps it from creating a
 * colourless duplicate.
 */
export function useTiltRelief(style: StyleSpecification): TiltReliefBinding {
  const tiltRelief = useSettingsStore((s) => s.tiltRelief);
  const [settledPitch, setSettledPitch] = useState(0);
  const [styleGeneration, setStyleGeneration] = useState(0);
  const onStyleLoaded = useCallback(() => setStyleGeneration((g) => g + 1), []);
  const onSettledPitch = useCallback((p: number) => setSettledPitch(pitchBucket(p)), []);
  const hasPass = useMemo(() => styleHasTiltRelief(style), [style]);
  const exaggeration = tiltReliefExaggeration(tiltRelief, settledPitch);
  const layer =
    hasPass && styleGeneration > 0 ? (
      <Fragment key={`tilt-relief-${styleGeneration}`}>{tiltReliefLayer(exaggeration)}</Fragment>
    ) : null;
  return { onStyleLoaded, onSettledPitch, layer };
}
