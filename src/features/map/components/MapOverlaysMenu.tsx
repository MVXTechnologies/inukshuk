import { useState } from 'react';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet } from 'react-native';
import { FAB, Menu } from 'react-native-paper';
import {
  DisclaimerSnackbar,
  TerrainOverlayMenuRows,
  useSlopeDisclaimer,
} from '../terrain3d/overlayControls';
import { EdgePill } from './EdgePill';

/**
 * The main map's terrain-overlays FAB + menu (Slope / Contours with their
 * detent sliders) — its own rail entry, mirroring the trail viewer's overlays
 * FAB, so the Layers menu stays about layers (PDF/trails/basemap/offline).
 * The menu stays open on toggle; Elevation tint is 3D-only and lives in the
 * 3D overlay bar instead.
 */
export function MapOverlaysMenu({ edgeAnchor }: { edgeAnchor?: boolean }) {
  const [open, setOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();
  const markedTrails = useSettingsStore((s) => s.markedTrailsOverlay);
  const set = useSettingsStore((s) => s.set);

  return (
    <>
      <Menu
        visible={open}
        onDismiss={() => setOpen(false)}
        anchor={
          edgeAnchor ? (
            <EdgePill
              icon="gradient-vertical"
              label="Overlays"
              onPress={() => setOpen(true)}
              accessibilityLabel="Map overlays"
            />
          ) : (
            <FAB
              icon="gradient-vertical"
              size="small"
              variant="surface"
              onPress={() => setOpen(true)}
              style={styles.controlFab}
              accessibilityLabel="Map overlays"
            />
          )
        }
      >
        <TerrainOverlayMenuRows showHypso={false} onSlopeEnabled={onSlopeEnabled} />
        {/* Waymarked Trails hiking routes — network tile overlay over the base. */}
        <Menu.Item
          leadingIcon={markedTrails ? 'checkbox-marked' : 'checkbox-blank-outline'}
          onPress={() => set('markedTrailsOverlay', !markedTrails)}
          title="Marked trails"
        />
      </Menu>
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

const styles = StyleSheet.create({
  controlFab: { borderRadius: 24 },
});
