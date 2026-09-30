import type { MapBasemap } from '@state/mapStore';
import { schemeTokens } from '@ui/tokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FAB, Icon, type MD3Theme, Menu, useTheme } from 'react-native-paper';
import {
  DisclaimerSnackbar,
  TerrainOverlayMenuRows,
  useSlopeDisclaimer,
} from './terrain3d/overlayControls';

/**
 * Right-edge control rail for the focused trail viewer: a layers FAB opening
 * the basemap picker and an overlays FAB opening the analytical-overlay
 * switches (the 2D↔3D toggle left in #480 — two-finger tilt instead) — the same circular-button idiom as
 * the main map's MapControlsRail/LayersMenu.
 *
 * The rail is strictly for VIEWING the trail. Trim used to live here as a
 * fourth FAB, but it edits the GPX rather than changing how the map is drawn,
 * so it now sits beside the trail name in Trail3DGLScreen's summary card,
 * next to the thing it edits (backlog item 6).
 */

/** Base-map choices: the same pair (labels, icons, colours) as the main map (#484). */
const BASEMAPS: {
  key: MapBasemap;
  label: string;
  icon: string;
  color: (t: MD3Theme) => string;
}[] = [
  { key: 'map', label: 'Map', icon: 'map', color: (t) => t.colors.primary },
  {
    key: 'satellite',
    label: 'Satellite',
    icon: 'satellite-variant',
    color: (t) => schemeTokens(t.dark).data.info,
  },
];

interface Props {
  /** Distance from the top of the viewport box (clears the summary card). */
  top: number;
  basemap: MapBasemap;
  onSelectBasemap: (bm: MapBasemap) => void;
  /** Disable the basemap picker while the 3D terrain is loading/rebuilding. */
  basemapDisabled?: boolean;
  /** Hide the overlays button when the overlay shader can't run on this device. */
  overlaysAvailable: boolean;
  /** Disable the overlay switches while the terrain is rebuilding. */
  overlaysDisabled?: boolean;
}

export function TrailViewerRail({
  top,
  basemap,
  onSelectBasemap,
  basemapDisabled,
  overlaysAvailable,
  overlaysDisabled,
}: Props) {
  return (
    <View style={[styles.rail, { top }]} pointerEvents="box-none">
      {/* No 2D↔3D toggle any more (#480, owner call): the focused view is the
          MapLibre map, tilted with two fingers like the main map. */}
      <TrailLayersMenu basemap={basemap} onSelect={onSelectBasemap} disabled={basemapDisabled} />
      {overlaysAvailable && <TrailOverlaysMenu disabled={overlaysDisabled} />}
    </View>
  );
}

/** The layers FAB + anchored basemap picker (Map / Satellite). */
function TrailLayersMenu({
  basemap,
  onSelect,
  disabled,
}: {
  basemap: MapBasemap;
  onSelect: (bm: MapBasemap) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <Menu
      visible={open}
      onDismiss={() => setOpen(false)}
      anchor={
        <FAB
          icon="layers"
          size="small"
          variant="surface"
          disabled={disabled}
          onPress={() => setOpen(true)}
          style={styles.controlFab}
          accessibilityLabel="Trail layers"
        />
      }
    >
      <Menu.Item disabled title="Base map" />
      {BASEMAPS.map((b) => (
        <Menu.Item
          key={b.key}
          leadingIcon={({ size }) => <Icon source={b.icon} size={size} color={b.color(theme)} />}
          trailingIcon={basemap === b.key ? 'check' : undefined}
          onPress={() => {
            setOpen(false);
            onSelect(b.key);
          }}
          title={b.label}
        />
      ))}
    </Menu>
  );
}

/**
 * The overlays FAB + anchored menu: Slope / Contours / Elevation-tint switches
 * and the contour-interval selector, bound to the settings store (same
 * persistence as the live 3D map's TerrainOverlayButtons). The menu stays open
 * on toggle so several layers can be flipped in one visit.
 */
function TrailOverlaysMenu({ disabled }: { disabled?: boolean }) {
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
            disabled={disabled}
            onPress={() => setOpen(true)}
            style={styles.controlFab}
            accessibilityLabel="Trail overlays"
          />
        }
      >
        <TerrainOverlayMenuRows showHypso onSlopeEnabled={onSlopeEnabled} />
      </Menu>
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

const styles = StyleSheet.create({
  rail: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  controlFab: { borderRadius: 24 },
});
