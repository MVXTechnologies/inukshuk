import type { MapBasemap } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Divider, FAB, Icon, type MD3Theme, Menu, useTheme } from 'react-native-paper';
import {
  CONTOUR_INTERVALS,
  DisclaimerSnackbar,
  contourIntervalLabel,
  useSlopeDisclaimer,
} from './terrain3d/overlayControls';

/**
 * Right-edge control rail for the focused trail viewer (2D and 3D modes): a
 * layers FAB opening the basemap picker and an overlays FAB opening the
 * analytical-overlay switches — the same circular-button idiom as the main
 * map's MapControlsRail/LayersMenu.
 */

/** Base-map choices: the same trio (labels, icons, colours) as the main map. */
const BASEMAPS: {
  key: MapBasemap;
  label: string;
  icon: string;
  color: (t: MD3Theme) => string;
}[] = [
  { key: 'relief', label: 'Relief', icon: 'image-filter-hdr', color: () => '#9C6B3F' },
  { key: 'map', label: 'Map', icon: 'map', color: (t) => t.colors.primary },
  {
    key: 'satellite',
    label: 'Satellite',
    icon: 'satellite-variant',
    color: (t) => t.colors.tertiary,
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
      <TrailLayersMenu basemap={basemap} onSelect={onSelectBasemap} disabled={basemapDisabled} />
      {overlaysAvailable && <TrailOverlaysMenu disabled={overlaysDisabled} />}
    </View>
  );
}

/** The layers FAB + anchored basemap picker (Relief / Map / Satellite). */
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
  const slope = useSettingsStore((s) => s.terrainSlope);
  const contours = useSettingsStore((s) => s.terrainContours);
  const hypso = useSettingsStore((s) => s.terrainHypso);
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const set = useSettingsStore((s) => s.set);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  const toggles: {
    key: 'terrainSlope' | 'terrainContours' | 'terrainHypso';
    title: string;
    on: boolean;
  }[] = [
    { key: 'terrainSlope', title: 'Slope', on: slope },
    { key: 'terrainContours', title: 'Contours', on: contours },
    { key: 'terrainHypso', title: 'Elevation tint', on: hypso },
  ];

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
        {toggles.map((t) => (
          <Menu.Item
            key={t.key}
            leadingIcon={t.on ? 'checkbox-marked' : 'checkbox-blank-outline'}
            onPress={() => {
              const next = !t.on;
              set(t.key, next);
              if (t.key === 'terrainSlope' && next) onSlopeEnabled();
            }}
            title={t.title}
          />
        ))}
        {contours && (
          <>
            <Divider />
            <Menu.Item disabled title="Contour interval" />
            {CONTOUR_INTERVALS.map((m) => (
              <Menu.Item
                key={m}
                trailingIcon={intervalM === m ? 'check' : undefined}
                onPress={() => set('terrainContourIntervalM', m)}
                title={contourIntervalLabel(m)}
              />
            ))}
          </>
        )}
      </Menu>
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

const styles = StyleSheet.create({
  rail: { position: 'absolute', right: 12, gap: 10, alignItems: 'flex-end' },
  controlFab: { borderRadius: 24 },
});
