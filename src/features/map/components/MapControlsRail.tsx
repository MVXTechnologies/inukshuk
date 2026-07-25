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
  /** Still threaded through: gates the hypso row in the overlays menu. */
  terrain3d: boolean;
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

/** Right-side map controls: locate, fit, base map, overlays. */
export function MapControlsRail(props: Props) {
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  const { minimalOpen, onMinimalOpenChange } = props;

  if (uiStyle === 'edge') return <EdgeRail {...props} />;

  const { top, onLocate, showFitControl, onFit, terrain3d, pdfOverlayCount, trackOverlayCount } =
    props;

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
      {/* 3D relief on the MAIN map: rolled back 2026-07-24 (user call — "not
          working so well ... until we figure it out"). The focused trail
          viewer keeps its 3D. To restore, re-add the video-3d FAB here (and
          its EdgePill in EdgeRail) — everything behind terrain3d still works. */}
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
