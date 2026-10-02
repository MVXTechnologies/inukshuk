import { isPerformedActivity } from '@core/dashboard/aggregate';
import { estimateMaxHrForLibrary, MAX_HR_RANGE, parseMaxHr } from '@core/stats/hrZones';
import { getTrailStatsStore } from '@data/trailStatsStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { Button, HelperText, List, TextInput } from 'react-native-paper';

/**
 * Settings › Training: the max heart rate the Logbook's heart-rate zones are
 * a share of. Empty = estimated from the activities (99th percentile of the
 * last 12 months' heart-rate samples); a typed value overrides it. Edited
 * inline — no dialog (a Paper Portal can swallow touches on One UI).
 */
export function TrainingSection() {
  const maxHr = useSettingsStore((s) => s.maxHeartRateBpm);
  const set = useSettingsStore((s) => s.set);
  const tracks = useLibraryStore((s) => s.tracks);
  const store = getTrailStatsStore();
  // Read what is already summarised; Settings never starts a backfill.
  const summaries = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.summaries(),
  );
  const [now] = useState(() => Date.now());
  const estimate = useMemo(
    () => estimateMaxHrForLibrary(tracks.filter(isPerformedActivity), summaries, now),
    [tracks, summaries, now],
  );
  const [draft, setDraft] = useState(maxHr > 0 ? String(maxHr) : '');
  const parsed = parseMaxHr(draft);
  const invalid = draft.trim() !== '' && parsed === null;
  const dirty = (parsed ?? 0) !== maxHr && !invalid;

  const save = () => {
    if (invalid) return;
    set('maxHeartRateBpm', parsed ?? 0);
    Keyboard.dismiss();
  };
  const clearOverride = () => {
    setDraft('');
    set('maxHeartRateBpm', 0);
    Keyboard.dismiss();
  };

  const estimateText =
    estimate === null
      ? 'Not enough heart-rate data to estimate yet'
      : `Estimated from your activities: ${estimate} bpm`;

  return (
    <List.Section>
      <List.Subheader>Heart rate</List.Subheader>
      <List.Item
        title="Max heart rate"
        description={maxHr > 0 ? `${maxHr} bpm, set by you. ${estimateText}.` : `${estimateText}.`}
        descriptionNumberOfLines={3}
      />
      <View style={styles.row}>
        <TextInput
          mode="outlined"
          label="Max heart rate (bpm)"
          placeholder={estimate !== null ? String(estimate) : '190'}
          value={draft}
          onChangeText={setDraft}
          keyboardType="number-pad"
          returnKeyType="done"
          onSubmitEditing={save}
          maxLength={3}
          style={styles.input}
          accessibilityLabel="Max heart rate in beats per minute"
        />
        <Button mode="contained-tonal" onPress={save} disabled={!dirty} style={styles.button}>
          Save
        </Button>
      </View>
      <HelperText type={invalid ? 'error' : 'info'} visible style={styles.helper}>
        {invalid
          ? `Enter a whole number from ${MAX_HR_RANGE.min} to ${MAX_HR_RANGE.max}.`
          : 'Leave empty to use the estimate. Zones: Z1 50–60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 90–100 %.'}
      </HelperText>
      {maxHr > 0 && (
        <View style={styles.reset}>
          <Button mode="text" onPress={clearOverride}>
            Use the estimate instead
          </Button>
        </View>
      )}
    </List.Section>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  input: { flex: 1 },
  button: { minHeight: 44, justifyContent: 'center', marginTop: 6 },
  helper: { paddingHorizontal: 16 },
  reset: { paddingHorizontal: 8, alignItems: 'flex-start' },
});
