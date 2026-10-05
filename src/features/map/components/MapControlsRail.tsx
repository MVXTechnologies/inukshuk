import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { MapTypePanel } from './LayersMenu';
import { MapActionsMenu, type MapActions } from './MapActionsMenu';
import { MapButton, MapButtonGroup } from './MapButton';
import { MapOverlaysMenu } from './MapOverlaysMenu';

interface Props {
  /** Distance from the top of the screen (safe-area inset + margin). */
  top: number;
  /** Whether the camera follows the user's position. */
  following: boolean;
  /** Start following (and zoom to a useful "where am I" level). */
  onLocate: () => void;
  /** Stop following, leaving the camera where it is. */
  onStopFollowing: () => void;
  /** Shown only when at least one PDF overlay is active. */
  showFitControl: boolean;
  onFit: () => void;
  pdfOverlayCount: number;
  trackOverlayCount: number;
  /**
   * The "+" map actions, the last button of the rail. undefined hides the
   * button entirely (recording under way, region select, category sheet
   * up) — 'Map actions' then leaves the a11y tree.
   */
  actions?: MapActions;
  /**
   * Compact map chrome: whether the chevron rail is unfolded. Owned by
   * MapScreen because it also gates other chrome; when compact, the "+"
   * actions button only shows while the controls are out (it lives here).
   */
  compactOpen: boolean;
  onCompactOpenChange: (open: boolean) => void;
  /** Any of the rail's sheets (map type, overlays, "+" actions) opened or closed. */
  onMenuOpenChange?: (open: boolean) => void;
  /**
   * The 3D/2D button (Settings → Beta features → 3D terrain only; undefined
   * hides it): `is3d` = the map is tilted, so the button offers 2D.
   */
  viewToggle?: { is3d: boolean; onPress: () => void };
}

/**
 * Right-side map controls (revamp `Main.html`, decision 2), top to bottom:
 * the target button (go to my position; tap again to stop following), Fit
 * map while PDF overlays are up, Base map and Map overlays joined in one
 * pill, then "+". Every button is a 48 dp {@link MapButton}; the Maestro
 * labels ('Locate', 'Fit map', 'Base map', 'Map overlays', 'Map actions',
 * 'Map controls', 'Hide map controls') are unchanged.
 */
export function MapControlsRail(props: Props) {
  const compact = useSettingsStore((s) => s.compactMapChrome);
  const { compactOpen, onCompactOpenChange } = props;
  // The Map type panel, the overlays sheet and the "+" actions sheet are all
  // plain-View sheets in the rail's own column; ONE open at a time, owned
  // here so an outside tap on the backdrop below closes whichever is up.
  const [openMenu, setOpenMenu] = useState<null | 'basemap' | 'overlays' | 'actions'>(null);
  const { onMenuOpenChange } = props;
  useEffect(() => {
    onMenuOpenChange?.(openMenu !== null);
  }, [openMenu, onMenuOpenChange]);

  const { top, following, onLocate, onStopFollowing, showFitControl, onFit, actions } = props;

  // Compact map chrome: everything folded behind one chevron until asked.
  if (compact && !compactOpen) {
    return (
      <View style={[styles.rightControls, { top }]} pointerEvents="box-none">
        <MapButton
          icon="chevron-left"
          onPress={() => onCompactOpenChange(true)}
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
          <MapButton
            icon="chevron-right"
            onPress={() => onCompactOpenChange(false)}
            accessibilityLabel="Hide map controls"
          />
        )}
        {/* Decision 2: a target, first in the rail. Idle it recentres and
            starts following; while following it is solid with the river-blue
            ink and a filled centre, and a tap stops following. */}
        <MapButton
          icon={following ? 'crosshairs-gps' : 'crosshairs'}
          selected={following}
          onPress={following ? onStopFollowing : onLocate}
          accessibilityLabel="Locate"
        />
        {props.viewToggle !== undefined && (
          <MapButton
            icon={props.viewToggle.is3d ? 'video-2d' : 'video-3d'}
            onPress={props.viewToggle.onPress}
            accessibilityLabel={props.viewToggle.is3d ? 'Switch to 2D view' : 'Switch to 3D view'}
          />
        )}
        {showFitControl && (
          <MapButton icon="fit-to-page-outline" onPress={onFit} accessibilityLabel="Fit map" />
        )}
        <MapButtonGroup>
          <MapButton
            icon="layers-outline"
            grouped
            onPress={() => setOpenMenu(openMenu === 'basemap' ? null : 'basemap')}
            accessibilityLabel="Base map"
          />
          <MapButton
            icon="gradient-vertical"
            grouped
            onPress={() => setOpenMenu(openMenu === 'overlays' ? null : 'overlays')}
            accessibilityLabel="Map overlays"
          />
        </MapButtonGroup>
        {openMenu === 'basemap' && <MapTypePanel onClose={() => setOpenMenu(null)} />}
        <MapOverlaysMenu
          hideTrigger
          open={openMenu === 'overlays'}
          onToggle={(o) => setOpenMenu(o ? 'overlays' : null)}
        />
        {/* The "+" folds away while the Map type panel or the Overlays sheet
            is up: under a tall sheet it was pushed onto the attribution chip
            (#484 emulator pass). It is back the moment the sheet closes. */}
        {actions !== undefined && openMenu !== 'basemap' && openMenu !== 'overlays' && (
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
  rightControls: { position: 'absolute', right: 16, gap: 8, alignItems: 'flex-end' },
  // While a sheet is up, the rail must stack above its backdrop.
  railAboveBackdrop: { zIndex: 5 },
  backdrop: { ...StyleSheet.absoluteFill, zIndex: 4 },
});
