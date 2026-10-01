import type { MapBasemap } from '@state/mapStore';
import { schemeTokens } from '@ui/tokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FAB, Icon, type MD3Theme, Menu, useTheme } from 'react-native-paper';
import {
  DisclaimerSnackbar,
  TerrainOverlayMenuRows,
  useSlopeDisclaimer,
} from './components/terrainOverlayControls';

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
}

export function TrailViewerRail({ top, basemap, onSelectBasemap }: Props) {
  return (
    <View style={[styles.rail, { top }]} pointerEvents="box-none">
      {/* No 2D↔3D toggle any more (#480, owner call): the focused view is the
          MapLibre map, tilted with two fingers like the main map. */}
      <TrailLayersMenu basemap={basemap} onSelect={onSelectBasemap} />
      <TrailOverlaysMenu />
    </View>
  );
}

/** The layers FAB + anchored basemap picker (Map / Satellite). */
function TrailLayersMenu({
  basemap,
  onSelect,
}: {
  basemap: MapBasemap;
  onSelect: (bm: MapBasemap) => void;
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
 * The overlays FAB + anchored menu: Slope / Contours switches and their
 * selectors, bound to the settings store (the same settings the main map's
 * overlays sheet drives). The menu stays open on toggle so several layers can
 * be flipped in one visit.
 */
function TrailOverlaysMenu() {
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
            accessibilityLabel="Trail overlays"
          />
        }
      >
        <TerrainOverlayMenuRows onSlopeEnabled={onSlopeEnabled} />
      </Menu>
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

const styles = StyleSheet.create({
  rail: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  controlFab: { borderRadius: 24 },
});
