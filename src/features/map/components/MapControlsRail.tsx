import { StyleSheet, View } from 'react-native';
import { FAB } from 'react-native-paper';
import { LayersMenu } from './LayersMenu';

interface Props {
  /** Distance from the top of the screen (safe-area inset + margin). */
  top: number;
  onLocate: () => void;
  /** Shown only when at least one PDF overlay is active. */
  showFitControl: boolean;
  onFit: () => void;
  /** Hide the download control while the 3D view is up. */
  terrain3d: boolean;
  onDownload: () => void;
  downloadDisabled: boolean;
  pdfOverlayCount: number;
  trackOverlayCount: number;
}

/** Right-side map controls: locate, fit-to-overlays, offline download, layers. */
export function MapControlsRail({
  top,
  onLocate,
  showFitControl,
  onFit,
  terrain3d,
  onDownload,
  downloadDisabled,
  pdfOverlayCount,
  trackOverlayCount,
}: Props) {
  return (
    <View style={[styles.rightControls, { top }]} pointerEvents="box-none">
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
      {/* 3D relief temporarily pulled back — the live-3D experience isn't where
          we want it yet. The Terrain3DLiveView code stays in the tree (gated off
          via the `terrain3d` store flag, which nothing toggles now) so it's ready
          to re-enable once the camera/gesture feel is dialed in. */}
      {!terrain3d && (
        <FAB
          icon="tray-arrow-down"
          size="small"
          variant="surface"
          onPress={onDownload}
          // Block re-entry while a download is running (a second download would
          // stop the first's loopback server mid-flight), and while recording.
          disabled={downloadDisabled}
          style={styles.controlFab}
          accessibilityLabel="Download offline area"
        />
      )}
      <LayersMenu pdfOverlayCount={pdfOverlayCount} trackOverlayCount={trackOverlayCount} />
    </View>
  );
}

const styles = StyleSheet.create({
  rightControls: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  controlFab: { borderRadius: 24 },
});
