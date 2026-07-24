import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FAB } from 'react-native-paper';
import { useSlopeDisclaimer } from '../terrain3d/overlayControls';
import { EdgeExpandingMenu } from './EdgeExpandingMenu';
import { EdgePill } from './EdgePill';
import { BasemapMenu, BasemapRows } from './LayersMenu';
import { MapOverlaysMenu, OverlaysDialogs, OverlaysRows } from './MapOverlaysMenu';

interface Props {
  /** Distance from the top of the screen (safe-area inset + margin). */
  top: number;
  onLocate: () => void;
  /** Shown only when at least one PDF overlay is active. */
  showFitControl: boolean;
  onFit: () => void;
  terrain3d: boolean;
  onToggle3d: () => void;
  /** Disable 3D entry while recording / selecting a region / downloading. */
  toggle3dDisabled: boolean;
  pdfOverlayCount: number;
  trackOverlayCount: number;
  /**
   * 'minimal' style: whether the chevron rail is unfolded. Owned by MapScreen
   * because the "+" dial is also gated on it — in minimal, the dial only shows
   * while the controls are out.
   */
  minimalOpen: boolean;
  onMinimalOpenChange: (open: boolean) => void;
}

/** Right-side map controls: locate, fit, 3D, base map, overlays. */
export function MapControlsRail(props: Props) {
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  const { minimalOpen, onMinimalOpenChange } = props;

  if (uiStyle === 'edge') return <EdgeRail {...props} />;

  const {
    top,
    onLocate,
    showFitControl,
    onFit,
    terrain3d,
    onToggle3d,
    toggle3dDisabled,
    pdfOverlayCount,
    trackOverlayCount,
  } = props;

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
    <View style={[styles.rightControls, { top }]} pointerEvents="box-none">
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
      {/* 3D relief — re-enabled for 1.2.0 now that terrain P2 (#137) shipped
          the camera/gesture polish it was pulled back to wait for (8f200bb). */}
      <FAB
        icon="video-3d"
        size="small"
        variant={terrain3d ? 'primary' : 'surface'}
        onPress={onToggle3d}
        // 3D is unstable while recording and meaningless while selecting or
        // downloading an offline region — disable it in those states.
        disabled={toggle3dDisabled}
        style={styles.controlFab}
        accessibilityLabel="3D relief"
      />
      <BasemapMenu />
      <MapOverlaysMenu
        pdfOverlayCount={pdfOverlayCount}
        trackOverlayCount={trackOverlayCount}
        showHypso={terrain3d}
      />
    </View>
  );
}

/**
 * 'edge' style: static half-pill actions (nothing to choose from — no
 * expansion), and two expanding menus that unfold horizontally then
 * vertically, all flush with the screen edge. One menu open at a time; a
 * transparent backdrop closes it.
 */
function EdgeRail({
  top,
  onLocate,
  showFitControl,
  onFit,
  terrain3d,
  onToggle3d,
  toggle3dDisabled,
  pdfOverlayCount,
  trackOverlayCount,
}: Props) {
  const [openMenu, setOpenMenu] = useState<null | 'basemap' | 'overlays'>(null);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [networksOpen, setNetworksOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  return (
    <>
      {openMenu !== null && <Pressable style={styles.backdrop} onPress={() => setOpenMenu(null)} />}
      <View style={[styles.edgeRail, { top }]} pointerEvents="box-none">
        <EdgePill icon="crosshairs-gps" label="Locate" onPress={onLocate} />
        {showFitControl && <EdgePill icon="fit-to-page-outline" label="Fit map" onPress={onFit} />}
        <EdgePill
          icon="video-3d"
          label="3D relief"
          onPress={onToggle3d}
          active={terrain3d}
          disabled={toggle3dDisabled}
          accessibilityLabel="3D relief"
        />
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
        >
          <OverlaysRows
            pdfOverlayCount={pdfOverlayCount}
            trackOverlayCount={trackOverlayCount}
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
  controlFab: { borderRadius: 24 },
  edgeRail: { position: 'absolute', right: 0, gap: 4, alignItems: 'flex-end', zIndex: 5 },
  backdrop: { ...StyleSheet.absoluteFill, zIndex: 4 },
});
