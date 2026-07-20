import type { BoundingBox } from '@core/models';
import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Button,
  Checkbox,
  ProgressBar,
  SegmentedButtons,
  Surface,
  Text,
  TextInput,
} from 'react-native-paper';
import type { DrapeSource } from '../dem';
import type { ComposePhase, MakeMapOptions } from './composeMapPdf';

/**
 * Options + progress sheet for the map maker (step after the region box).
 * Inline Surface (never Portal/Dialog — see paper-portal-touch-swallow):
 * options first, then a determinate progress view while composing.
 */

export type MakeMapProgress = { phase: ComposePhase; frac: number };

interface Props {
  bbox: BoundingBox;
  /** Non-null while composing — switches the sheet to its progress view. */
  progress: MakeMapProgress | null;
  onCreate: (options: MakeMapOptions) => void;
  onCancel: () => void;
}

const PHASE_LABEL: Record<ComposePhase, string> = {
  tiles: 'Fetching map tiles…',
  terrain: 'Analyzing terrain…',
  compose: 'Composing the PDF…',
};

/** Overall progress: each phase owns a third of the bar. */
const PHASE_BASE: Record<ComposePhase, number> = { tiles: 0, terrain: 1 / 3, compose: 2 / 3 };

export function MakeMapSheet({ bbox, progress, onCreate, onCancel }: Props) {
  void bbox;
  const s = useSettingsStore.getState();
  const [name, setName] = useState(`My map ${new Date().toISOString().slice(0, 10)}`);
  const [basemap, setBasemap] = useState<DrapeSource>('map');
  const [format, setFormat] = useState<'a4' | 'letter'>('a4');
  const [contours, setContours] = useState(true);
  const [slope, setSlope] = useState(s.terrainSlope);
  const [includeUserData, setIncludeUserData] = useState(true);

  if (progress) {
    const value = PHASE_BASE[progress.phase] + progress.frac / 3;
    return (
      <Surface style={styles.sheet} elevation={4}>
        <Text variant="titleSmall" style={styles.title}>
          Making “{name}”
        </Text>
        <Text variant="bodySmall" style={styles.phase}>
          {PHASE_LABEL[progress.phase]}
        </Text>
        <ProgressBar progress={value} style={styles.bar} />
        <View style={styles.actions}>
          <Button mode="outlined" onPress={onCancel} style={styles.actionBtn}>
            Cancel
          </Button>
        </View>
      </Surface>
    );
  }

  return (
    <Surface style={styles.sheet} elevation={4}>
      <Text variant="titleSmall" style={styles.title}>
        Make a map
      </Text>
      <TextInput
        mode="outlined"
        dense
        label="Map name"
        defaultValue={name}
        onChangeText={setName}
        style={styles.nameInput}
      />
      <SegmentedButtons
        value={basemap}
        onValueChange={(v) => setBasemap(v as DrapeSource)}
        density="small"
        buttons={[
          { value: 'map', label: 'Map' },
          { value: 'satellite', label: 'Satellite' },
        ]}
        style={styles.row}
      />
      <SegmentedButtons
        value={format}
        onValueChange={(v) => setFormat(v as 'a4' | 'letter')}
        density="small"
        buttons={[
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
        ]}
        style={styles.row}
      />
      <View style={styles.checks}>
        <Checkbox.Item
          label="Contour lines"
          status={contours ? 'checked' : 'unchecked'}
          onPress={() => setContours(!contours)}
          position="leading"
          labelStyle={styles.checkLabel}
        />
        <Checkbox.Item
          label="Slope shading"
          status={slope ? 'checked' : 'unchecked'}
          onPress={() => setSlope(!slope)}
          position="leading"
          labelStyle={styles.checkLabel}
        />
        <Checkbox.Item
          label="My tracks & waypoints"
          status={includeUserData ? 'checked' : 'unchecked'}
          onPress={() => setIncludeUserData(!includeUserData)}
          position="leading"
          labelStyle={styles.checkLabel}
        />
      </View>
      <View style={styles.actions}>
        <Button mode="outlined" onPress={onCancel} style={styles.actionBtn}>
          Cancel
        </Button>
        <Button
          mode="contained"
          style={styles.actionBtn}
          onPress={() => {
            const settings = useSettingsStore.getState();
            onCreate({
              name: name.trim() || 'My map',
              format,
              basemap,
              contours,
              contourIntervalM: settings.terrainContourIntervalM,
              slope,
              slopeMinDeg: settings.terrainSlopeMinDeg,
              slopeMaxDeg: settings.terrainSlopeMaxDeg,
              includeUserData,
            });
          }}
        >
          Create
        </Button>
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 16,
    padding: 14,
    gap: 8,
  },
  title: { textAlign: 'center' },
  nameInput: { marginBottom: 2 },
  row: { marginVertical: 2 },
  checks: { marginVertical: -4 },
  checkLabel: { textAlign: 'left' },
  phase: { textAlign: 'center' },
  bar: { marginVertical: 10, height: 6, borderRadius: 3 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  actionBtn: { minWidth: 110 },
});
