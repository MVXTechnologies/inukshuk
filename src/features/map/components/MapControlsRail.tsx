import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FAB } from 'react-native-paper';
import { BasemapMenu } from './LayersMenu';
import { MapActionsMenu, type MapActions } from './MapActionsMenu';
import { MapOverlaysMenu } from './MapOverlaysMenu';

interface Props {
  /** Distance from the top of the screen (safe-area inset + margin). */
  top: number;
  onLocate: () => void;
  /** Shown only when at least one PDF overlay is active. */
  showFitControl: boolean;
  onFit: () => void;
  /** Still threaded through: gates the hypso row in the overlays menu. */
  terrain3d: boolean;
  pdfOverlayCount: number;
  trackOverlayCount: number;
  /**
   * The "+" map actions (wave A item 6: moved here from the bottom-right
   * FAB.Group), rendered as a rail button directly below Map overlays.
   * undefined hides the button entirely (recording under way, region select,
   * category sheet up) — 'Map actions' then leaves the a11y tree, exactly
   * like the old FAB's own gating.
   */
  actions?: MapActions;
  /**
   * Compact map chrome: whether the chevron rail is unfolded. Owned by
   * MapScreen because it also gates other chrome; when compact, the "+"
   * actions button only shows while the controls are out (it lives here).
   */
  compactOpen: boolean;
  onCompactOpenChange: (open: boolean) => void;
}

/** Right-side map controls: locate, fit, base map, overlays, map actions. */
export function MapControlsRail(props: Props) {
  const compact = useSettingsStore((s) => s.compactMapChrome);
  const { compactOpen, onCompactOpenChange } = props;
  // The overlays drill-down and the "+" actions sheet are both plain-View
  // sheets in the rail's own column; ONE open at a time, owned here so an
  // outside tap on the backdrop below closes whichever is up.
  const [openMenu, setOpenMenu] = useState<null | 'overlays' | 'actions'>(null);

  const { top, onLocate, showFitControl, onFit, terrain3d, actions } = props;

  // Compact map chrome: everything folded behind one small chevron until asked.
  if (compact && !compactOpen) {
    return (
      <View style={[styles.rightControls, { top }]} pointerEvents="box-none">
        <FAB
          icon="chevron-left"
          size="small"
          variant="surface"
          onPress={() => onCompactOpenChange(true)}
          style={styles.controlFab}
          accessibilityLabel="Map controls"
        />
      </View>
    );
  }

  return (
    <>
      {openMenu !== null && <Pressable style={styles.backdrop} onPress={() => setOpenMenu(null)} />}
      <View
        style={[styles.rightControls, styles.railAboveBackdrop, { top }]}
        pointerEvents="box-none"
      >
        {compact && (
          <FAB
            icon="chevron-right"
            size="small"
            variant="surface"
            onPress={() => onCompactOpenChange(false)}
            style={styles.controlFab}
            accessibilityLabel="Hide map controls"
          />
        )}
        <FAB
          icon="crosshairs-gps"
          size="small"
          variant="surface"
          onPress={onLocate}
          style={styles.controlFab}
          accessibilityLabel="Locate"
        />
        {showFitControl && (
          <FAB
            icon="fit-to-page-outline"
            size="small"
            variant="surface"
            onPress={onFit}
            style={styles.controlFab}
            accessibilityLabel="Fit map"
          />
        )}
        {/* 3D relief on the MAIN map: rolled back 2026-07-24 (user call — "not
            working so well ... until we figure it out"). The focused trail
            viewer keeps its 3D. To restore, re-add the video-3d FAB here —
            everything behind terrain3d still works. */}
        <BasemapMenu />
        <MapOverlaysMenu
          showHypso={terrain3d}
          open={openMenu === 'overlays'}
          onToggle={(o) => setOpenMenu(o ? 'overlays' : null)}
        />
        {/* "+" map actions, directly below Map overlays (wave A item 6). */}
        {actions !== undefined && (
          <MapActionsMenu
            actions={actions}
            open={openMenu === 'actions'}
            onToggle={(o) => setOpenMenu(o ? 'actions' : null)}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  rightControls: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  // While a sheet is up, the rail must stack above its backdrop.
  railAboveBackdrop: { zIndex: 5 },
  controlFab: { borderRadius: 24 },
  backdrop: { ...StyleSheet.absoluteFill, zIndex: 4 },
});
