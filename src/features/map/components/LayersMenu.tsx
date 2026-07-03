import { setOfflineOnly } from '@data/offline';
import { type MapBasemap, useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Divider, FAB, Icon, type MD3Theme, Menu, useTheme } from 'react-native-paper';

/** Base-map choices shown in the layers menu, each with its own coloured icon. */
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
  /** Number of georeferenced PDF overlays available to toggle. */
  pdfOverlayCount: number;
  /** Number of saved-trail overlays available to toggle. */
  trackOverlayCount: number;
}

/**
 * The layers FAB + menu: overlay toggles (PDF pages, saved trails), the
 * "locally downloaded only" network switch, and the base-map picker.
 */
export function LayersMenu({ pdfOverlayCount, trackOverlayCount }: Props) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const showPdfOverlay = useMapStore((s) => s.showPdfOverlay);
  const togglePdfOverlay = useMapStore((s) => s.togglePdfOverlay);
  const showTrackOverlays = useMapStore((s) => s.showTrackOverlays);
  const toggleTrackOverlays = useMapStore((s) => s.toggleTrackOverlays);
  const basemap = useMapStore((s) => s.basemap);
  const setBasemap = useMapStore((s) => s.setBasemap);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const set = useSettingsStore((s) => s.set);

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
          accessibilityLabel="Layers"
        />
      }
    >
      <Menu.Item disabled title="Overlays" />
      <Menu.Item
        leadingIcon={showPdfOverlay ? 'checkbox-marked' : 'checkbox-blank-outline'}
        onPress={pdfOverlayCount > 0 ? togglePdfOverlay : undefined}
        disabled={pdfOverlayCount === 0}
        title={`PDF (${pdfOverlayCount})`}
      />
      <Menu.Item
        leadingIcon={showTrackOverlays ? 'checkbox-marked' : 'checkbox-blank-outline'}
        onPress={trackOverlayCount > 0 ? toggleTrackOverlays : undefined}
        disabled={trackOverlayCount === 0}
        title={`Trails (${trackOverlayCount})`}
      />
      <Divider />
      <Menu.Item
        leadingIcon={offlineOnly ? 'checkbox-marked' : 'checkbox-blank-outline'}
        onPress={() => {
          const next = !offlineOnly;
          set('offlineOnly', next);
          setOfflineOnly(next);
        }}
        title="Locally downloaded only"
      />
      <Divider />
      <Menu.Item disabled title="Base map" />
      {BASEMAPS.map((b) => (
        <Menu.Item
          key={b.key}
          leadingIcon={({ size }) => <Icon source={b.icon} size={size} color={b.color(theme)} />}
          trailingIcon={basemap === b.key ? 'check' : undefined}
          onPress={() => {
            setBasemap(b.key);
            setOpen(false);
          }}
          title={b.label}
        />
      ))}
    </Menu>
  );
}

const styles = StyleSheet.create({
  controlFab: { borderRadius: 24 },
});
