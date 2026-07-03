import { DEFAULT_TILE_URL, useSettingsStore } from '@state/settingsStore';
import Constants from 'expo-constants';
import { useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import {
  Appbar,
  Button,
  Dialog,
  Divider,
  HelperText,
  List,
  Portal,
  SegmentedButtons,
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OfflineMapsSection } from './OfflineMapsSection';

const DISPLACEMENT_OPTIONS = [
  { value: '2', label: '2 m' },
  { value: '5', label: '5 m' },
  { value: '10', label: '10 m' },
];

const UNITS_OPTIONS = [
  { value: 'metric', label: 'Metric (km)' },
  { value: 'imperial', label: 'Imperial (mi)' },
];

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
  const set = useSettingsStore((s) => s.set);
  const reset = useSettingsStore((s) => s.reset);

  const [tileDialogVisible, setTileDialogVisible] = useState(false);
  const [tileDraft, setTileDraft] = useState('');

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
        <List.Section>
          <List.Subheader>Recording</List.Subheader>
          <List.Item
            title="Keep screen awake"
            description="Prevents the device sleeping while recording"
            right={() => (
              <Switch value={keepAwake} onValueChange={(v) => set('keepAwakeWhileRecording', v)} />
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
        </List.Section>

        <Divider />

        <List.Section>
          <List.Subheader>Map</List.Subheader>
          <List.Item
            title="Rotate map with compass"
            description="Turn the map to match your heading"
            right={() => (
              <Switch value={rotateMap} onValueChange={(v) => set('rotateMapWithHeading', v)} />
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
              Inukshuk uses free OpenStreetMap raster tiles. For heavy public use, point this at
              your own tile cache or a free provider to respect the OSM tile usage policy.
            </Text>
          </View>
        </List.Section>

        <Divider />

        <OfflineMapsSection />

        <Divider />

        <List.Section>
          <List.Subheader>About</List.Subheader>
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
          <List.Item title="Version" description={`${Constants.expoConfig?.version ?? '1.0.0'}`} />
          <List.Item title="Maps & data" description="© OpenStreetMap contributors" />
          <View style={styles.note}>
            <Button mode="outlined" icon="restore" onPress={reset}>
              Reset settings
            </Button>
          </View>
        </List.Section>
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
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  segment: { paddingHorizontal: 16, paddingBottom: 8 },
  note: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  logoWrap: { alignItems: 'center', paddingVertical: 12, gap: 2 },
  logo: { width: 84, height: 84, borderRadius: 18 },
  logoName: { fontWeight: '700', marginTop: 6 },
  logoTag: { opacity: 0.7 },
});
