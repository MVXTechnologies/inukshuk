import { useSettingsStore } from '@state/settingsStore';
import { useEffect, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Portal, Snackbar } from 'react-native-paper';
import { useTimedSnackbar, type TimedSnackbar } from '../../common/useTimedSnackbar';
import {
  applyTerrainOverlaySettings,
  type TerrainOverlayHandle,
  type TerrainOverlaySettings,
} from './terrainMaterial';

/**
 * Shared UI + store wiring for the 3D analytical overlays (slope bands,
 * contour lines, hypsometric tint) used by both the trail viewer (via its
 * TrailViewerRail menus) and the live 3D map (via TerrainOverlayButtons).
 * State persists in the settings store.
 */

/** Contour-interval choices the interval button cycles through (0 = auto). */
export const CONTOUR_INTERVALS = [0, 10, 25, 50, 100] as const;

export function contourIntervalLabel(m: number): string {
  return m === 0 ? 'Auto' : `${m} m`;
}

export const SLOPE_DISCLAIMER = 'Slope shading is indicative — not for avalanche decision-making.';

/** Snapshot the persisted overlay settings (non-reactive; for post-build use). */
export function currentOverlaySettings(): TerrainOverlaySettings {
  const s = useSettingsStore.getState();
  return {
    slope: s.terrainSlope,
    contours: s.terrainContours,
    hypso: s.terrainHypso,
    contourIntervalM: s.terrainContourIntervalM,
  };
}

/**
 * Keep a built terrain's overlay uniforms in sync with the settings store.
 * The ref is written by async terrain builds; those call
 * `applyTerrainOverlaySettings(handle, currentOverlaySettings())` themselves —
 * this hook covers the toggles changing while a build is live.
 */
export function useTerrainOverlaySync(
  overlayRef: RefObject<TerrainOverlayHandle | null>,
): TerrainOverlaySettings {
  const slope = useSettingsStore((s) => s.terrainSlope);
  const contours = useSettingsStore((s) => s.terrainContours);
  const hypso = useSettingsStore((s) => s.terrainHypso);
  const contourIntervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  useEffect(() => {
    const handle = overlayRef.current;
    if (handle) applyTerrainOverlaySettings(handle, { slope, contours, hypso, contourIntervalM });
  }, [slope, contours, hypso, contourIntervalM, overlayRef]);
  return { slope, contours, hypso, contourIntervalM };
}

/**
 * One-time slope disclaimer: call `onSlopeEnabled` whenever the slope layer is
 * switched on; the message shows once per install (persisted flag). Render the
 * returned snackbar in the screen (duration Infinity + useTimedSnackbar — see
 * that hook for why paper's own timer can't be trusted).
 */
export function useSlopeDisclaimer(): { snackbar: TimedSnackbar; onSlopeEnabled: () => void } {
  const snackbar = useTimedSnackbar(7000);
  const shown = useSettingsStore((s) => s.slopeDisclaimerShown);
  const set = useSettingsStore((s) => s.set);
  const onSlopeEnabled = () => {
    if (shown) return;
    set('slopeDisclaimerShown', true);
    snackbar.show(SLOPE_DISCLAIMER);
  };
  return { snackbar, onSlopeEnabled };
}

interface ButtonsProps {
  /** Disable while the terrain is rebuilding. */
  disabled?: boolean;
  /** Hide entirely when the overlay shader is unavailable on this device. */
  available: boolean;
}

/**
 * The Slope / Contours / Tint toggle buttons + the contour-interval cycler,
 * bound to the settings store. Used by the live 3D map (the trail viewer
 * offers the same switches through its overlays menu instead).
 */
export function TerrainOverlayButtons({ disabled, available }: ButtonsProps) {
  const slope = useSettingsStore((s) => s.terrainSlope);
  const contours = useSettingsStore((s) => s.terrainContours);
  const hypso = useSettingsStore((s) => s.terrainHypso);
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const set = useSettingsStore((s) => s.set);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  if (!available) return null;

  const toggles: {
    key: 'terrainSlope' | 'terrainContours' | 'terrainHypso';
    label: string;
    icon: string;
    on: boolean;
  }[] = [
    { key: 'terrainSlope', label: 'Slope', icon: 'angle-acute', on: slope },
    { key: 'terrainContours', label: 'Contours', icon: 'reorder-horizontal', on: contours },
    { key: 'terrainHypso', label: 'Tint', icon: 'terrain', on: hypso },
  ];

  return (
    <View style={styles.row} pointerEvents="box-none">
      {toggles.map((t) => (
        <Button
          key={t.key}
          compact
          icon={t.icon}
          mode={t.on ? 'contained' : 'contained-tonal'}
          disabled={disabled}
          onPress={() => {
            const next = !t.on;
            set(t.key, next);
            if (t.key === 'terrainSlope' && next) onSlopeEnabled();
          }}
          style={styles.btn}
          labelStyle={styles.label}
        >
          {t.label}
        </Button>
      ))}
      {contours && (
        <Button
          compact
          icon="arrow-expand-vertical"
          mode="contained-tonal"
          disabled={disabled}
          onPress={() => {
            const i = CONTOUR_INTERVALS.indexOf(intervalM as (typeof CONTOUR_INTERVALS)[number]);
            set('terrainContourIntervalM', CONTOUR_INTERVALS[(i + 1) % CONTOUR_INTERVALS.length]!);
          }}
          style={styles.btn}
          labelStyle={styles.label}
          accessibilityLabel="Contour interval"
        >
          {contourIntervalLabel(intervalM)}
        </Button>
      )}
      <DisclaimerSnackbar snackbar={snackbar} />
    </View>
  );
}

/** The one-time slope disclaimer, floated via Portal above the host screen. */
export function DisclaimerSnackbar({ snackbar }: { snackbar: TimedSnackbar }) {
  return (
    <Portal>
      <Snackbar
        visible={snackbar.message !== null}
        onDismiss={snackbar.dismiss}
        duration={Number.POSITIVE_INFINITY}
      >
        {snackbar.message ?? ''}
      </Snackbar>
    </Portal>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  btn: { borderRadius: 20 },
  label: { marginVertical: 4, marginHorizontal: 8, fontSize: 12 },
});
