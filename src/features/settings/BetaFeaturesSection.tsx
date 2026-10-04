/**
 * Settings → Beta features: one switch per entry of the beta registry
 * (@core/settings/betaFeatures). Each beta is a boolean in the settings store,
 * off by default; adding a beta needs no change here.
 */
import { BETA_FEATURES, BETA_FEATURES_NOTE } from '@core/settings/betaFeatures';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { List, Switch, Text } from 'react-native-paper';

export function BetaFeaturesSection() {
  const values = useSettingsStore((s) => s);
  const set = useSettingsStore((s) => s.set);
  return (
    <List.Section>
      <View style={styles.note}>
        <Text variant="bodySmall">{BETA_FEATURES_NOTE}</Text>
      </View>
      {BETA_FEATURES.map((f) => (
        <List.Item
          key={f.key}
          title={f.title}
          description={f.description}
          descriptionNumberOfLines={3}
          right={() => (
            <Switch
              value={values[f.key]}
              onValueChange={(v) => set(f.key, v)}
              accessibilityLabel={`${f.title} (beta)`}
            />
          )}
        />
      ))}
    </List.Section>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingVertical: 8 },
});
