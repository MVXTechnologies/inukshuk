import { planDataArchive } from '@core/export/archivePlan';
import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import * as storage from '@data/storage';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import {
  type ErrorQueueStatus,
  type FlushResult,
  flushErrorQueue,
  getErrorQueueStatus,
} from '@lib/errorReporting';
import { formatBytes } from '@lib/format';
import { useLibraryStore } from '@state/libraryStore';
import { DEFAULT_TILE_URL, useSettingsStore } from '@state/settingsStore';
import type { UiStyle } from '@ui/theme';
import Constants from 'expo-constants';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Dialog,
  Divider,
  HelperText,
  List,
  Portal,
  SegmentedButtons,
  Snackbar,
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { exportAllData } from './exportAllData';
import { OfflineMapsSection } from './OfflineMapsSection';
import { StravaSection } from './StravaSection';

const DISPLACEMENT_OPTIONS = [
  { value: '2', label: '2 m' },
  { value: '5', label: '5 m' },
  { value: '10', label: '10 m' },
];

const UNITS_OPTIONS = [
  { value: 'metric', label: 'Metric (km)' },
  { value: 'imperial', label: 'Imperial (mi)' },
];

/** One-line outcome of a manual "Send now" flush (shown in a timed snackbar). */
function describeFlush(result: FlushResult): string {
  switch (result.status) {
    case 'delivered':
      return `Sent ${result.delivered} error report${result.delivered === 1 ? '' : 's'}.`;
    case 'empty':
      return 'No pending error reports.';
    case 'disabled':
      return 'Automatic error reporting is off.';
    case 'no-channel':
      return 'This build cannot file reports; they stay queued on this device.';
    case 'rate-limited':
      return 'Daily report limit reached — the rest will be sent later.';
    case 'backoff':
    case 'failed':
      return 'Could not send now — reports stay queued and will retry.';
  }
}

/** Sub-line for the (developer-facing) error-report queue row. */
function describeQueue(status: ErrorQueueStatus): string {
  const pending =
    status.queued === 0
      ? 'No pending reports'
      : `${status.queued} report${status.queued === 1 ? '' : 's'} waiting to send`;
  if (status.channel === 'none') return `${pending} · this build cannot file reports`;
  if (status.lastFailure !== null) return `${pending} · last attempt: ${status.lastFailure}`;
  return `${pending} · ${status.sentToday} sent today`;
}

/** A usable raster-tile URL template: http(s) with {z}/{x}/{y} placeholders. */
function isValidTileUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) && url.includes('{z}') && url.includes('{x}') && url.includes('{y}')
  );
}

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const keepAwake = useSettingsStore((s) => s.keepAwakeWhileRecording);
  const rotateMap = useSettingsStore((s) => s.rotateMapWithHeading);
  const minDisplacement = useSettingsStore((s) => s.minDisplacementM);
  const units = useSettingsStore((s) => s.units);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  const errorReporting = useSettingsStore((s) => s.errorReporting);
  const set = useSettingsStore((s) => s.set);
  const reset = useSettingsStore((s) => s.reset);

  const [tileDialogVisible, setTileDialogVisible] = useState(false);
  const [tileDraft, setTileDraft] = useState('');

  // "Download your data" — everything in the Library as one zip.
  const maps = useLibraryStore((s) => s.maps);
  const tracks = useLibraryStore((s) => s.tracks);
  const folders = useLibraryStore((s) => s.folders);
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const activeMapId = useLibraryStore((s) => s.activeMapId);
  const activeTrackIds = useLibraryStore((s) => s.activeTrackIds);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const exporting = exportProgress !== null;
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3500);

  // Error-report queue diagnostics. Purely informational: the reporter files
  // reports on its own in the background and never prompts the user — this row
  // just makes the queue visible (and lets a developer force a flush).
  const [queueStatus, setQueueStatus] = useState<ErrorQueueStatus | null>(null);
  const [sendingReports, setSendingReports] = useState(false);

  const refreshQueueStatus = useCallback(() => {
    getErrorQueueStatus()
      .then(setQueueStatus)
      .catch(() => undefined);
  }, []);

  useEffect(refreshQueueStatus, [refreshQueueStatus]);

  const onSendReports = () => {
    if (sendingReports) return;
    setSendingReports(true);
    flushErrorQueue({ force: true })
      .then((result) => showSnack(describeFlush(result)))
      .catch(() => showSnack('Could not send now — reports stay queued and will retry.'))
      .finally(() => {
        setSendingReports(false);
        refreshQueueStatus();
      });
  };

  const exportPlan = useMemo(
    () => planDataArchive({ folders, maps, tracks }),
    [folders, maps, tracks],
  );
  // Uncompressed total of every planned file — a good upper-bound estimate for
  // the zip (maps/photos are stored, only the small GPX/JSON parts deflate).
  const exportSizeBytes = useMemo(
    () => exportPlan.entries.reduce((sum, e) => sum + storage.fileSizeAt(e.sourceUri), 0),
    [exportPlan],
  );

  const exportSubtitle = useMemo(() => {
    if (exportPlan.entries.length === 0) return 'Your library is empty';
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = [plural(exportPlan.trackCount, 'trail'), plural(exportPlan.mapCount, 'map')];
    if (exportPlan.photoCount > 0) parts.push(plural(exportPlan.photoCount, 'photo'));
    return `${parts.join(', ')} · ~${formatBytes(exportSizeBytes)} zip`;
  }, [exportPlan, exportSizeBytes]);

  const onDownloadData = async () => {
    if (exporting) return;
    setExportProgress({ done: 0, total: exportPlan.entries.length });
    const result = await exportAllData(
      exportPlan,
      // Snapshot mirroring what libraryStore persists, if library.json is absent.
      {
        schemaVersion: LIBRARY_SCHEMA_VERSION,
        maps,
        tracks,
        folders,
        mapVisibilityMode,
        visibleFolderIds,
        activeMapId,
        activeTrackIds,
      },
      {
        onProgress: (done, total) => setExportProgress({ done, total }),
        // The only outcome we can vouch for: the zip exists. Say so *before* the
        // share sheet opens — once it closes, the platform tells us nothing about
        // whether the user saved the archive or just backed out.
        onReady: (files, bytes) =>
          showSnack(
            `Archive ready — ${files} file${files === 1 ? '' : 's'}, ${formatBytes(bytes)}`,
          ),
      },
    );
    setExportProgress(null);
    // `shared` is silent on purpose: never claim a success we cannot verify.
    if (result.kind === 'unavailable') {
      showSnack('Sharing is not available on this device');
    } else if (result.kind === 'error') {
      showSnack(`Export failed: ${result.message}`);
    }
  };

  const openTileDialog = () => {
    setTileDraft(tileUrl === DEFAULT_TILE_URL ? '' : tileUrl);
    setTileDialogVisible(true);
  };

  const trimmedDraft = tileDraft.trim();
  const draftValid = trimmedDraft === '' || isValidTileUrl(trimmedDraft);

  const saveTileUrl = () => {
    if (!draftValid) return;
    set('tileUrl', trimmedDraft === '' ? DEFAULT_TILE_URL : trimmedDraft);
    setTileDialogVisible(false);
  };

  return (
    <View style={styles.fill}>
      <Appbar.Header>
        <Appbar.Content title="Settings" />
      </Appbar.Header>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        {/* Five collapsible categories (owner's grouping, backlog item 4);
            AccordionGroup keeps one open at a time. Each body is a single
            View: Paper clones a paddingLeft onto direct accordion children
            that lack left/right props, which would stagger mixed rows — one
            wrapper neutralizes that and keeps rows full-width. */}
        <List.AccordionGroup>
          <List.Accordion
            id="app"
            title="App settings"
            description="Recording, display and map"
            left={(p) => <List.Icon {...p} icon="tune" />}
          >
            <View style={styles.accordionBody}>
              <List.Section>
                <List.Subheader>Recording</List.Subheader>
                <List.Item
                  title="Keep screen awake"
                  description="Prevents the device sleeping while recording"
                  right={() => (
                    <Switch
                      value={keepAwake}
                      onValueChange={(v) => set('keepAwakeWhileRecording', v)}
                    />
                  )}
                />
                <List.Item
                  title="GPS point spacing"
                  description="Minimum distance between recorded fixes"
                />
                <View style={styles.segment}>
                  <SegmentedButtons
                    value={String(minDisplacement)}
                    onValueChange={(v) => set('minDisplacementM', Number(v))}
                    buttons={DISPLACEMENT_OPTIONS}
                  />
                </View>
              </List.Section>

              <Divider />

              <List.Section>
                <List.Subheader>Display</List.Subheader>
                <List.Item title="Units" description="Distances, elevation, speed and pace" />
                <View style={styles.segment}>
                  <SegmentedButtons
                    value={units}
                    onValueChange={(v) => set('units', v === 'imperial' ? 'imperial' : 'metric')}
                    buttons={UNITS_OPTIONS}
                  />
                </View>
                <List.Item title="Theme" description="Follow the system, or force light / dark" />
                <View style={styles.segment}>
                  <SegmentedButtons
                    value={themeMode}
                    onValueChange={(v) => set('themeMode', v as 'system' | 'light' | 'dark')}
                    buttons={[
                      { value: 'system', label: 'System' },
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ]}
                  />
                </View>
                <List.Item
                  title="App style"
                  description="Classic brand look, quiet Minimal, or the pastel Edge style"
                />
                <View style={styles.segment}>
                  <SegmentedButtons
                    value={uiStyle}
                    onValueChange={(v) => set('uiStyle', v as UiStyle)}
                    buttons={[
                      { value: 'classic', label: 'Classic' },
                      { value: 'minimal', label: 'Minimal' },
                      { value: 'edge', label: 'Edge' },
                    ]}
                  />
                </View>
              </List.Section>

              <Divider />

              <List.Section>
                <List.Subheader>Map</List.Subheader>
                <List.Item
                  title="Rotate map with compass"
                  description="Turn the map to match your heading"
                  right={() => (
                    <Switch
                      value={rotateMap}
                      onValueChange={(v) => set('rotateMapWithHeading', v)}
                    />
                  )}
                />
                <List.Item
                  title="Base map tiles"
                  description={tileUrl === DEFAULT_TILE_URL ? 'OpenStreetMap (default)' : tileUrl}
                  onPress={openTileDialog}
                  right={(p) => <List.Icon {...p} icon="pencil-outline" />}
                />
                <View style={styles.note}>
                  <Text variant="bodySmall">
                    Inukshuk uses free OpenStreetMap raster tiles. For heavy public use, point this
                    at your own tile cache or a free provider to respect the OSM tile usage policy.
                  </Text>
                </View>
              </List.Section>
            </View>
          </List.Accordion>

          <Divider />

          <List.Accordion
            id="data"
            title="Data settings"
            // Deliberately does NOT repeat body text ("Offline maps"): E2E
            // guards detect the open state by body-only text, and iOS exposes
            // this description as its own accessibility element.
            description="Storage, downloads and export"
            left={(p) => <List.Icon {...p} icon="database-outline" />}
          >
            <View style={styles.accordionBody}>
              <OfflineMapsSection />

              <Divider />

              <List.Section>
                <List.Subheader>Your data</List.Subheader>
                <List.Item
                  title="Download your data"
                  description={
                    exporting
                      ? `Building archive… ${Math.min(exportProgress.done + 1, exportProgress.total)}/${exportProgress.total} files`
                      : exportSubtitle
                  }
                  onPress={onDownloadData}
                  disabled={exporting || exportPlan.entries.length === 0}
                  right={(p) =>
                    exporting ? (
                      <ActivityIndicator style={p.style} size={20} />
                    ) : (
                      <List.Icon {...p} icon="download" />
                    )
                  }
                />
                <View style={styles.note}>
                  <Text variant="bodySmall">
                    Bundles every map, trail and note photo into a zip that mirrors your Library
                    folders, then opens the share sheet.
                  </Text>
                </View>
              </List.Section>
            </View>
          </List.Accordion>

          <Divider />

          <List.Accordion
            id="thirdparty"
            title="Third party"
            description="Strava and other connections"
            left={(p) => <List.Icon {...p} icon="link-variant" />}
          >
            <View style={styles.accordionBody}>
              <StravaSection showSnack={showSnack} />
            </View>
          </List.Accordion>

          <Divider />

          <List.Accordion
            id="system"
            title="System settings"
            description="Error reporting and reset"
            left={(p) => <List.Icon {...p} icon="cog-outline" />}
          >
            <View style={styles.accordionBody}>
              <List.Section>
                <List.Subheader>Privacy</List.Subheader>
                <List.Item
                  title="Automatic error reporting"
                  description="Send app errors to the developer automatically (queued while offline)"
                  right={() => (
                    <Switch
                      value={errorReporting}
                      onValueChange={(v) => set('errorReporting', v)}
                    />
                  )}
                />
                {queueStatus !== null && (
                  <List.Item
                    title="Error report queue"
                    description={describeQueue(queueStatus)}
                    onPress={onSendReports}
                    disabled={!errorReporting || sendingReports || queueStatus.queued === 0}
                    right={(p) =>
                      sendingReports ? (
                        <ActivityIndicator style={p.style} size={20} />
                      ) : (
                        <List.Icon {...p} icon="send-outline" />
                      )
                    }
                  />
                )}
                <View style={styles.note}>
                  <Text variant="bodySmall">
                    Reports are filed in the background — you are never asked to do anything. They
                    contain only the error details, app version and device model — never your
                    location, maps or trails.
                  </Text>
                </View>
              </List.Section>
              <View style={styles.note}>
                <Button mode="outlined" icon="restore" onPress={reset}>
                  Reset settings
                </Button>
              </View>
            </View>
          </List.Accordion>

          <Divider />

          <List.Accordion
            id="info"
            title="System info"
            // Same rule: don't echo body text ("Version", "Maps & data").
            description="About Inukshuk"
            left={(p) => <List.Icon {...p} icon="information-outline" />}
          >
            <View style={styles.accordionBody}>
              <View style={styles.logoWrap}>
                <Image
                  source={require('../../../assets/icon.png')}
                  style={styles.logo}
                  resizeMode="contain"
                />
                <Text variant="titleMedium" style={styles.logoName}>
                  Inukshuk
                </Text>
                <Text variant="bodySmall" style={styles.logoTag}>
                  Offline trail navigation
                </Text>
              </View>
              <List.Item
                title="Version"
                description={`${Constants.expoConfig?.version ?? '1.0.0'}`}
              />
              {/* The map screen no longer shows MapLibre's attribution button
              (owner call — it crowded the map), so this row is the one place
              the data credits live. Keep every provider listed. */}
              <List.Item
                title="Maps & data"
                description="© OpenStreetMap contributors · Esri/ArcGIS basemaps · AWS Terrain Tiles · MapLibre"
              />
            </View>
          </List.Accordion>
        </List.AccordionGroup>
      </ScrollView>

      <Portal>
        <Dialog visible={tileDialogVisible} onDismiss={() => setTileDialogVisible(false)}>
          <Dialog.Title>Base map tiles</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Tile URL template"
              value={tileDraft}
              onChangeText={setTileDraft}
              mode="outlined"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder={DEFAULT_TILE_URL}
            />
            <HelperText type={draftValid ? 'info' : 'error'} visible>
              {draftValid
                ? 'Leave empty to use the default OpenStreetMap tiles.'
                : 'Must start with http(s):// and contain {z}, {x} and {y} placeholders.'}
            </HelperText>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setTileDialogVisible(false)}>Cancel</Button>
            <Button onPress={saveTileUrl} disabled={!draftValid}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={snack !== null}
        onDismiss={dismissSnack}
        duration={Number.POSITIVE_INFINITY}
      >
        {snack ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Zeroes the paddingLeft Paper clones onto a lone accordion child, so
  // category bodies keep the same full-width row layout as before.
  accordionBody: { paddingLeft: 0 },
  segment: { paddingHorizontal: 16, paddingBottom: 8 },
  note: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  logoWrap: { alignItems: 'center', paddingVertical: 12, gap: 2 },
  logo: { width: 84, height: 84, borderRadius: 18 },
  logoName: { fontWeight: '700', marginTop: 6 },
  logoTag: { opacity: 0.7 },
});
