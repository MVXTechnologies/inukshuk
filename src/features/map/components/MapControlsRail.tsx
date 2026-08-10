import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FAB } from 'react-native-paper';
import { useSlopeDisclaimer } from '../terrain3d/overlayControls';
import { weatherChrome as wc } from '../weather/weatherChrome';
import { EdgeExpandingMenu } from './EdgeExpandingMenu';
import { EdgePill } from './EdgePill';
import { BasemapMenu, BasemapRows } from './LayersMenu';
import { MapActionsMenu, type MapActions } from './MapActionsMenu';
import { MapOverlaysMenu, OverlaysDialogs, OverlaysDrilldown } from './MapOverlaysMenu';

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
   * 'minimal' style: whether the chevron rail is unfolded. Owned by MapScreen
   * because it also gates other chrome; in minimal, the "+" actions button
   * only shows while the controls are out (it lives in this rail).
   */
  minimalOpen: boolean;
  onMinimalOpenChange: (open: boolean) => void;
}

/** Right-side map controls: locate, fit, base map, overlays, map actions. */
export function MapControlsRail(props: Props) {
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  const { minimalOpen, onMinimalOpenChange } = props;
  // The overlays drill-down and the "+" actions sheet are both plain-View
  // sheets in the rail's own column; ONE open at a time, owned here so an
  // outside tap on the backdrop below closes whichever is up.
  const [openMenu, setOpenMenu] = useState<null | 'overlays' | 'actions'>(null);

  if (uiStyle === 'edge') return <EdgeRail {...props} />;

  const { top, onLocate, showFitControl, onFit, terrain3d, actions } = props;

  // 'minimal' style: everything folded behind one small chevron until asked.
  if (uiStyle === 'minimal' && !minimalOpen) {
    return (
      <View style={[styles.rightControls, { top }]} pointerEvents="box-none">
        <FAB
          icon="chevron-left"
          size="small"
          variant="surface"
          onPress={() => onMinimalOpenChange(true)}
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
        {uiStyle === 'minimal' && (
          <FAB
            icon="chevron-right"
            size="small"
            variant="surface"
            onPress={() => onMinimalOpenChange(false)}
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
          />
        )}
        {/* 3D relief on the MAIN map: rolled back 2026-07-24 (user call — "not
            working so well ... until we figure it out"). The focused trail
            viewer keeps its 3D. To restore, re-add the video-3d FAB here (and
            its EdgePill in EdgeRail) — everything behind terrain3d still works. */}
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

/**
 * 'edge' style: static half-pill actions (nothing to choose from — no
 * expansion), and two expanding menus that unfold horizontally then
 * vertically, all flush with the screen edge. One menu open at a time; a
 * transparent backdrop closes it. The overlays menu's panel hosts the same
 * drill-down as the classic sheet, on the fixed dark weather chrome.
 */
function EdgeRail({ top, onLocate, showFitControl, onFit, terrain3d, actions }: Props) {
  const [openMenu, setOpenMenu] = useState<null | 'basemap' | 'overlays' | 'actions'>(null);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [networksOpen, setNetworksOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  return (
    <>
      {openMenu !== null && <Pressable style={styles.backdrop} onPress={() => setOpenMenu(null)} />}
      <View style={[styles.edgeRail, { top }]} pointerEvents="box-none">
        <EdgePill icon="crosshairs-gps" label="Locate" onPress={onLocate} />
        {showFitControl && <EdgePill icon="fit-to-page-outline" label="Fit map" onPress={onFit} />}
        {/* 3D pill removed with the main-map 3D rollback — see the classic
            rail's note. */}
        <EdgeExpandingMenu
          icon="image-filter-hdr"
          label="Base map"
          open={openMenu === 'basemap'}
          onToggle={(o) => setOpenMenu(o ? 'basemap' : null)}
        >
          <BasemapRows onPicked={() => setOpenMenu(null)} />
        </EdgeExpandingMenu>
        <EdgeExpandingMenu
          icon="gradient-vertical"
          label="Overlays"
          accessibilityLabel="Map overlays"
          open={openMenu === 'overlays'}
          onToggle={(o) => setOpenMenu(o ? 'overlays' : null)}
          panelColor={wc.panelSolid}
        >
          <OverlaysDrilldown
            showHypso={terrain3d}
            onSlopeEnabled={onSlopeEnabled}
            onOpenFolders={() => {
              setOpenMenu(null);
              setFoldersOpen(true);
            }}
            onOpenTrailNetworks={() => {
              setOpenMenu(null);
              setNetworksOpen(true);
            }}
          />
        </EdgeExpandingMenu>
        {/* "+" map actions, below the overlays menu (wave A item 6). */}
        {actions !== undefined && (
          <MapActionsMenu
            edge
            actions={actions}
            open={openMenu === 'actions'}
            onToggle={(o) => setOpenMenu(o ? 'actions' : null)}
          />
        )}
      </View>
      <OverlaysDialogs
        foldersOpen={foldersOpen}
        onFoldersDismiss={() => setFoldersOpen(false)}
        networksOpen={networksOpen}
        onNetworksDismiss={() => setNetworksOpen(false)}
        snackbar={snackbar}
      />
    </>
  );
}

const styles = StyleSheet.create({
  rightControls: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  // While a sheet is up, the rail must stack above its backdrop.
  railAboveBackdrop: { zIndex: 5 },
  controlFab: { borderRadius: 24 },
  edgeRail: { position: 'absolute', right: 0, gap: 4, alignItems: 'flex-end', zIndex: 5 },
  backdrop: { ...StyleSheet.absoluteFill, zIndex: 4 },
});
