import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { Icon, Portal, Snackbar, Text, TouchableRipple } from 'react-native-paper';
import { useTimedSnackbar, type TimedSnackbar } from '../../common/useTimedSnackbar';
import { DetentSlider } from './DetentSlider';
import { RangeSlider } from './RangeSlider';

/**
 * Shared UI + store wiring for the terrain overlays (slope bands, contour
 * lines) used by the main map's overlays menu and the trail viewer's
 * TrailViewerRail menu. State persists in the settings store; both maps draw
 * the overlays through MapLibre (useTerrainOverlays2D, served contours).
 */

/** Contour-interval choices the density pickers offer (0 = auto). */
export const CONTOUR_INTERVALS = [0, 10, 25, 50, 100] as const;

export function contourIntervalLabel(m: number): string {
  return m === 0 ? 'Auto' : `${m} m`;
}

export const SLOPE_DISCLAIMER = 'Slope shading is indicative — not for avalanche decision-making.';

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

/**
 * Menu rows for the terrain overlays, shared by the main map's overlays menu
 * and the trail viewer's. Each layer is ONE compact row: checkbox + title on
 * the left, its selector (slope range / contour interval) inline on the
 * RIGHT — stacked selector rows ate too much vertical space. Rows render
 * their sliders ALWAYS (dimmed while off): paper's Menu measures its content
 * once at open and never re-anchors. `onSlopeEnabled` comes from
 * {@link useSlopeDisclaimer}; the host renders the DisclaimerSnackbar itself.
 */
export function TerrainOverlayMenuRows({ onSlopeEnabled }: { onSlopeEnabled: () => void }) {
  const slope = useSettingsStore((s) => s.terrainSlope);
  const contours = useSettingsStore((s) => s.terrainContours);
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const slopeMinDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const slopeMaxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);
  const set = useSettingsStore((s) => s.set);

  return (
    <>
      <View style={styles.layerRow}>
        <TouchableRipple
          onPress={() => {
            const next = !slope;
            set('terrainSlope', next);
            if (next) onSlopeEnabled();
          }}
          style={styles.layerToggle}
          accessibilityLabel="Slope"
        >
          <View style={styles.layerLabelBox}>
            <Icon source={slope ? 'checkbox-marked' : 'checkbox-blank-outline'} size={20} />
            <Text variant="bodyLarge">Slope</Text>
          </View>
        </TouchableRipple>
        <View style={styles.rightCol}>
          <RangeSlider
            min={0}
            max={90}
            width={100}
            lo={slopeMinDeg}
            hi={slopeMaxDeg}
            disabled={!slope}
            accessibilityLabel="Slope"
            onChange={(newLo, newHi) => {
              set('terrainSlopeMinDeg', newLo);
              set('terrainSlopeMaxDeg', newHi);
            }}
          />
        </View>
      </View>
      <View style={styles.layerRow}>
        <TouchableRipple
          onPress={() => set('terrainContours', !contours)}
          style={styles.layerToggle}
          accessibilityLabel="Contours"
        >
          <View style={styles.layerLabelBox}>
            <Icon source={contours ? 'checkbox-marked' : 'checkbox-blank-outline'} size={20} />
            <Text variant="bodyLarge">Contours</Text>
          </View>
        </TouchableRipple>
        <View style={[styles.rightCol, !contours && styles.sliderRowDisabled]}>
          <DetentSlider
            detents={CONTOUR_INTERVALS.map((m) => ({ value: m, label: contourIntervalLabel(m) }))}
            selected={intervalM}
            onSelect={(m) => set('terrainContourIntervalM', m)}
            disabled={!contours}
            width={100}
          />
        </View>
      </View>
    </>
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
  layerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 12,
    minWidth: 300,
  },
  layerToggle: { paddingVertical: 10, paddingLeft: 12, paddingRight: 6 },
  layerLabelBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Shared right column: both sliders' tracks and value labels line up.
  rightCol: { width: 170, alignItems: 'flex-end' },
  sliderRowDisabled: { opacity: 0.35 },
});
