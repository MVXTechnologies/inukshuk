import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { FAB, Menu } from 'react-native-paper';
import {
  DisclaimerSnackbar,
  TerrainOverlayMenuRows,
  useSlopeDisclaimer,
} from '../terrain3d/overlayControls';

/**
 * The main map's terrain-overlays FAB + menu (Slope / Contours with their
 * detent sliders) — its own rail entry, mirroring the trail viewer's overlays
 * FAB, so the Layers menu stays about layers (PDF/trails/basemap/offline).
 * The menu stays open on toggle; Elevation tint is 3D-only and lives in the
 * 3D overlay bar instead.
 */
export function MapOverlaysMenu() {
  const [open, setOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  return (
    <>
      <Menu
        visible={open}
        onDismiss={() => setOpen(false)}
        anchor={
          <FAB
            icon="gradient-vertical"
            size="small"
            variant="surface"
            onPress={() => setOpen(true)}
            style={styles.controlFab}
            accessibilityLabel="Map overlays"
          />
        }
      >
        <TerrainOverlayMenuRows showHypso={false} onSlopeEnabled={onSlopeEnabled} />
      </Menu>
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

const styles = StyleSheet.create({
  controlFab: { borderRadius: 24 },
});
