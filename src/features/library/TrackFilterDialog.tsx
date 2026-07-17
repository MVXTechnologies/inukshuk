import { allCategories } from '@core/library/categories';
import { UNCATEGORIZED, type NumericRange, type TrackFilter } from '@core/library/filterTracks';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Dialog, Icon, Portal, Text, TextInput, useTheme } from 'react-native-paper';

interface Props {
  visible: boolean;
  onDismiss: () => void;
  /** Apply the built criteria (an empty object clears the filter). */
  onApply: (filter: TrackFilter) => void;
}

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

type DatePreset = 'any' | 'week' | 'month' | 'year';
const DATE_PRESETS: { key: DatePreset; label: string; days?: number }[] = [
  { key: 'any', label: 'Any time' },
  { key: 'week', label: '7 days', days: 7 },
  { key: 'month', label: '30 days', days: 30 },
  { key: 'year', label: '12 months', days: 365 },
];

/** Lenient numeric parse for a filter field: '' / junk → undefined (no bound). */
function parseBound(raw: string): number | undefined {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Build a criterion range from min/max input strings, scaled to base units. */
function range(minRaw: string, maxRaw: string, scale: number): NumericRange | undefined {
  const min = parseBound(minRaw);
  const max = parseBound(maxRaw);
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min !== undefined ? { min: min * scale } : {}),
    ...(max !== undefined ? { max: max * scale } : {}),
  };
}

/**
 * Library filter panel (opened from the appbar's filter icon): distance,
 * duration, elevation gain, date, pace and category criteria feed the pure
 * `filterTracks` predicate. The draft inputs live in this component's state,
 * which survives close/reopen (the dialog stays mounted), so the panel always
 * reflects the active filter. User-initiated, so a Portal Dialog is fine.
 */
export function TrackFilterDialog({ visible, onDismiss, onApply }: Props) {
  const theme = useTheme();
  const units = useSettingsStore((s) => s.units);
  const customCategories = useLibraryStore((s) => s.customCategories);
  const imperial = units === 'imperial';

  const [categories, setCategories] = useState<string[]>([]);
  const [distMin, setDistMin] = useState('');
  const [distMax, setDistMax] = useState('');
  const [durMin, setDurMin] = useState('');
  const [durMax, setDurMax] = useState('');
  const [gainMin, setGainMin] = useState('');
  const [gainMax, setGainMax] = useState('');
  const [paceMin, setPaceMin] = useState('');
  const [paceMax, setPaceMax] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('any');

  const toggleCategory = (id: string) =>
    setCategories((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));

  const buildFilter = (): TrackFilter => {
    const distScale = imperial ? M_PER_MI : 1000; // input in mi / km
    const gainScale = imperial ? M_PER_FT : 1; // input in ft / m
    const paceScale = imperial ? (60 * 1000) / M_PER_MI : 60; // min/mi | min/km → s/km
    const preset = DATE_PRESETS.find((p) => p.key === datePreset);
    const distanceM = range(distMin, distMax, distScale);
    const durationS = range(durMin, durMax, 3600); // input in hours
    const ascentM = range(gainMin, gainMax, gainScale);
    const paceSecPerKm = range(paceMin, paceMax, paceScale);
    return {
      ...(distanceM ? { distanceM } : {}),
      ...(durationS ? { durationS } : {}),
      ...(ascentM ? { ascentM } : {}),
      ...(paceSecPerKm ? { paceSecPerKm } : {}),
      ...(preset?.days !== undefined
        ? { startedAt: { min: Date.now() - preset.days * 24 * 3600 * 1000 } }
        : {}),
      ...(categories.length > 0 ? { categories } : {}),
    };
  };

  const clearAll = () => {
    setCategories([]);
    setDistMin('');
    setDistMax('');
    setDurMin('');
    setDurMax('');
    setGainMin('');
    setGainMax('');
    setPaceMin('');
    setPaceMax('');
    setDatePreset('any');
    onApply({});
  };

  const apply = () => {
    onApply(buildFilter());
    onDismiss();
  };

  const rangeRow = (
    label: string,
    unit: string,
    min: string,
    setMin: (v: string) => void,
    max: string,
    setMax: (v: string) => void,
  ) => (
    <View style={styles.section}>
      <Text variant="labelLarge">{`${label} (${unit})`}</Text>
      <View style={styles.rangeRow}>
        <TextInput
          mode="outlined"
          dense
          label="Min"
          value={min}
          onChangeText={setMin}
          keyboardType="numeric"
          style={styles.rangeInput}
          accessibilityLabel={`${label} minimum`}
        />
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          –
        </Text>
        <TextInput
          mode="outlined"
          dense
          label="Max"
          value={max}
          onChangeText={setMax}
          keyboardType="numeric"
          style={styles.rangeInput}
          accessibilityLabel={`${label} maximum`}
        />
      </View>
    </View>
  );

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={styles.dialog}>
        <Dialog.Title>Filter trails</Dialog.Title>
        <Dialog.ScrollArea style={styles.scrollArea}>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.section}>
              <Text variant="labelLarge">Category</Text>
              <View style={styles.chipWrap}>
                {allCategories(customCategories).map((c) => {
                  const on = categories.includes(c.id);
                  return (
                    <Chip
                      key={c.id}
                      mode="outlined"
                      selected={on}
                      showSelectedCheck={false}
                      icon={({ size }) => <Icon source={c.icon} size={size} color={c.color} />}
                      onPress={() => toggleCategory(c.id)}
                      style={{
                        borderColor: on ? c.color : theme.colors.outline,
                        borderWidth: on ? 2 : 1,
                        backgroundColor: on ? `${c.color}26` : 'transparent',
                      }}
                      accessibilityLabel={`Filter category ${c.name}${on ? ', on' : ''}`}
                    >
                      {c.name}
                    </Chip>
                  );
                })}
                <Chip
                  mode="outlined"
                  selected={categories.includes(UNCATEGORIZED)}
                  icon="help-circle-outline"
                  onPress={() => toggleCategory(UNCATEGORIZED)}
                  accessibilityLabel="Filter uncategorized trails"
                >
                  Uncategorized
                </Chip>
              </View>
            </View>

            <View style={styles.section}>
              <Text variant="labelLarge">Date</Text>
              <View style={styles.chipWrap}>
                {DATE_PRESETS.map((p) => (
                  <Chip
                    key={p.key}
                    mode="outlined"
                    selected={datePreset === p.key}
                    onPress={() => setDatePreset(p.key)}
                    accessibilityLabel={`Recorded within ${p.label}`}
                  >
                    {p.label}
                  </Chip>
                ))}
              </View>
            </View>

            {rangeRow('Distance', imperial ? 'mi' : 'km', distMin, setDistMin, distMax, setDistMax)}
            {rangeRow('Duration', 'hours', durMin, setDurMin, durMax, setDurMax)}
            {rangeRow(
              'Elevation gain D+',
              imperial ? 'ft' : 'm',
              gainMin,
              setGainMin,
              gainMax,
              setGainMax,
            )}
            {rangeRow(
              'Pace',
              imperial ? 'min/mi' : 'min/km',
              paceMin,
              setPaceMin,
              paceMax,
              setPaceMax,
            )}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={clearAll}>Clear all</Button>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button mode="contained" onPress={apply}>
            Apply
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  dialog: { maxHeight: '85%' },
  scrollArea: { paddingHorizontal: 0 },
  content: { paddingHorizontal: 24, paddingVertical: 8, gap: 16 },
  section: { gap: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rangeInput: { flex: 1 },
});
