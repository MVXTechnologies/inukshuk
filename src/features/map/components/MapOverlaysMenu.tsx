import { setOfflineOnly } from '@data/offline';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Divider, FAB, Menu } from 'react-native-paper';
import {
  DisclaimerSnackbar,
  TerrainOverlayMenuRows,
  useSlopeDisclaimer,
} from '../terrain3d/overlayControls';
import { weatherLayerById } from '@core/geo/weatherLayers';
import { MarineLayersDialog } from '../marine/MarineLayersDialog';
import { WeatherLayersDialog } from '../weather/WeatherLayersDialog';
import { EdgePill } from './EdgePill';
import { FolderPickerDialog } from './FolderPickerDialog';
import { TrailNetworksDialog } from './TrailNetworksDialog';

/**
 * THE overlays menu — everything drawn on top of the base map lives here:
 * imported content visibility (PDF pages / saved trails / folder mode),
 * terrain analysis (slope + contours with inline selectors), the marked-trail
 * databases popup, and the offline-only switch. The mountain menu next door
 * is only the base map. Shared row set (`OverlaysRows`) renders identically
 * inside the classic paper Menu and the edge rail's expanding panel.
 */

export function OverlaysRows({
  pdfOverlayCount,
  trackOverlayCount,
  showHypso,
  onSlopeEnabled,
  onOpenFolders,
  onOpenTrailNetworks,
  onOpenWeather,
  onOpenMarine,
}: {
  pdfOverlayCount: number;
  trackOverlayCount: number;
  /** Show the 3D-only Elevation tint row (when the 3D view is active). */
  showHypso: boolean;
  onSlopeEnabled: () => void;
  onOpenFolders: () => void;
  onOpenTrailNetworks: () => void;
  onOpenWeather: () => void;
  onOpenMarine: () => void;
}) {
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const typeMode = mapVisibilityMode === 'type';
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const networks = useSettingsStore((s) => s.markedTrailsNetworks);
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const marineLayers = useSettingsStore((s) => s.marineLayers);
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const set = useSettingsStore((s) => s.set);

  return (
    <>
      {/* PDF/Trails type toggles retired — the folder picker (with its
          Everything and Ungrouped rows) covers content visibility. */}
      <Menu.Item
        leadingIcon={typeMode ? 'folder-multiple-outline' : 'folder-multiple'}
        onPress={onOpenFolders}
        title={
          typeMode
            ? 'Content: everything'
            : `Content: ${visibleFolderIds.length} folder${visibleFolderIds.length === 1 ? '' : 's'}`
        }
      />
      <Divider />
      <TerrainOverlayMenuRows showHypso={showHypso} onSlopeEnabled={onSlopeEnabled} />
      <Menu.Item
        leadingIcon={networks.length > 0 ? 'checkbox-marked' : 'checkbox-blank-outline'}
        onPress={onOpenTrailNetworks}
        title={networks.length > 0 ? `Marked trails (${networks.length})` : 'Marked trails'}
      />
      {/* Weather is network-only: while "Locally downloaded only" is on the
          layer is dropped from the style, so the row is disabled with a hint
          instead of pretending a toggle would show anything. */}
      <Menu.Item
        leadingIcon="weather-partly-cloudy"
        disabled={offlineOnly}
        onPress={onOpenWeather}
        title={
          offlineOnly
            ? 'Weather (needs connection)'
            : weatherLayer !== null
              ? `Weather: ${weatherLayerById(weatherLayer).label}`
              : 'Weather'
        }
      />
      {/* Marine layers are network-only too — same disabled/hint treatment
          as Weather while "Locally downloaded only" is on. */}
      <Menu.Item
        leadingIcon="anchor"
        disabled={offlineOnly}
        onPress={onOpenMarine}
        title={
          offlineOnly
            ? 'Marine (needs connection)'
            : marineLayers.length > 0
              ? `Marine (${marineLayers.length})`
              : 'Marine'
        }
      />
      <Menu.Item
        leadingIcon={showHeatmap ? 'checkbox-marked' : 'checkbox-blank-outline'}
        onPress={() => set('showHeatmap', !showHeatmap)}
        title="Heatmap"
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
    </>
  );
}

/** The dialogs the rows open, hosted once by whichever rail is showing. */
export function OverlaysDialogs({
  foldersOpen,
  onFoldersDismiss,
  networksOpen,
  onNetworksDismiss,
  weatherOpen,
  onWeatherDismiss,
  marineOpen,
  onMarineDismiss,
  snackbar,
}: {
  foldersOpen: boolean;
  onFoldersDismiss: () => void;
  networksOpen: boolean;
  onNetworksDismiss: () => void;
  weatherOpen: boolean;
  onWeatherDismiss: () => void;
  marineOpen: boolean;
  onMarineDismiss: () => void;
  snackbar: ReturnType<typeof useSlopeDisclaimer>['snackbar'];
}) {
  return (
    <>
      <FolderPickerDialog visible={foldersOpen} onDismiss={onFoldersDismiss} />
      <TrailNetworksDialog visible={networksOpen} onDismiss={onNetworksDismiss} />
      <WeatherLayersDialog visible={weatherOpen} onDismiss={onWeatherDismiss} />
      <MarineLayersDialog visible={marineOpen} onDismiss={onMarineDismiss} />
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

/** Classic/minimal styles: overlays FAB + paper Menu. */
export function MapOverlaysMenu({
  pdfOverlayCount,
  trackOverlayCount,
  showHypso = false,
  edgeAnchor,
}: {
  pdfOverlayCount: number;
  trackOverlayCount: number;
  showHypso?: boolean;
  edgeAnchor?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [networksOpen, setNetworksOpen] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [marineOpen, setMarineOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

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
        <OverlaysRows
          pdfOverlayCount={pdfOverlayCount}
          trackOverlayCount={trackOverlayCount}
          showHypso={showHypso}
          onSlopeEnabled={onSlopeEnabled}
          onOpenFolders={() => {
            setOpen(false);
            setFoldersOpen(true);
          }}
          onOpenTrailNetworks={() => {
            setOpen(false);
            setNetworksOpen(true);
          }}
          onOpenWeather={() => {
            setOpen(false);
            setWeatherOpen(true);
          }}
          onOpenMarine={() => {
            setOpen(false);
            setMarineOpen(true);
          }}
        />
      </Menu>
      <OverlaysDialogs
        foldersOpen={foldersOpen}
        onFoldersDismiss={() => setFoldersOpen(false)}
        networksOpen={networksOpen}
        onNetworksDismiss={() => setNetworksOpen(false)}
        weatherOpen={weatherOpen}
        onWeatherDismiss={() => setWeatherOpen(false)}
        marineOpen={marineOpen}
        onMarineDismiss={() => setMarineOpen(false)}
        snackbar={snackbar}
      />
    </>
  );
}

const styles = StyleSheet.create({
  controlFab: { borderRadius: 24 },
});
