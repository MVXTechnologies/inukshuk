import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FAB } from 'react-native-paper';
import { EdgePill } from './EdgePill';
import { LayersMenu } from './LayersMenu';
import { MapOverlaysMenu } from './MapOverlaysMenu';

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
}

/** Right-side map controls: locate, fit-to-overlays, 3D, layers, overlays. */
export function MapControlsRail({
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
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  // 'minimal' style: the rail rests as a single chevron; tapping it unfolds
  // the buttons and the chevron flips to fold them away again.
  const [minimalOpen, setMinimalOpen] = useState(false);

  // 'edge' style: half-pills flush with the screen edge, packed tight — the
  // rail shrinks to a sliver of the map compared to the floating FAB column.
  if (uiStyle === 'edge') {
    return (
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
        <LayersMenu
          pdfOverlayCount={pdfOverlayCount}
          trackOverlayCount={trackOverlayCount}
          edgeAnchor
        />
        <MapOverlaysMenu edgeAnchor />
      </View>
    );
  }

  // 'minimal' style: everything folded behind one small chevron until asked.
  if (uiStyle === 'minimal' && !minimalOpen) {
    return (
      <View style={[styles.rightControls, { top }]} pointerEvents="box-none">
        <FAB
          icon="chevron-left"
          size="small"
          variant="surface"
          onPress={() => setMinimalOpen(true)}
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
          onPress={() => setMinimalOpen(false)}
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
      <LayersMenu pdfOverlayCount={pdfOverlayCount} trackOverlayCount={trackOverlayCount} />
      <MapOverlaysMenu />
    </View>
  );
}

const styles = StyleSheet.create({
  rightControls: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  controlFab: { borderRadius: 24 },
  edgeRail: { position: 'absolute', right: 0, gap: 4, alignItems: 'flex-end' },
});
