import type { DisplayCondition } from '@core/display/condition';
import { sunTimes } from '@core/sun/sunTimes';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Switch, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const CARDS: { condition: DisplayCondition; title: string; caption: string; icon: string }[] = [
  { condition: 'normal', title: 'Normal', caption: 'Paper & stone', icon: 'weather-partly-cloudy' },
  {
    condition: 'sunlight',
    title: 'Sunlight',
    caption: 'Max contrast',
    icon: 'white-balance-sunny',
  },
  { condition: 'night', title: 'Night', caption: 'Red only', icon: 'weather-night' },
];

/**
 * The Display sheet (decision 4, `Display-Modes.html`): three large cards for
 * Normal / Sunlight / Night red, and the two opt-in toggles. Sunlight and
 * Night are never on unless chosen here (or by a toggle turned on here).
 * A plain Modal, not a Paper Portal.
 */
export function DisplaySheet({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const chosen = useSettingsStore((s) => s.displayCondition);
  const autoNight = useSettingsStore((s) => s.autoNightAtSunset);
  const sunlightRecording = useSettingsStore((s) => s.sunlightWhileRecording);
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const set = useSettingsStore((s) => s.set);
  // Sampled when the sheet mounts; the caption only names tonight's time.
  const [openedAt] = useState(() => Date.now());

  const sunset =
    position === null ? null : sunTimes(openedAt, position.latitude, position.longitude).sunset;
  const autoCaption =
    sunset === null
      ? 'After sunset, off at sunrise'
      : `On at ${new Date(sunset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} tonight, off at sunrise`;

  const ink = theme.colors.onSurface;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable
        style={styles.backdrop}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close display options"
      />
      <View
        style={[
          styles.sheet,
          { backgroundColor: theme.colors.surface, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.title, { color: ink }]} accessibilityRole="header">
            Display
          </Text>
          <Text style={[styles.subtitle, { color: tokens.inkMuted }]}>
            Sunlight and Night are opt-in. Normal is the default.
          </Text>

          <View style={styles.cards}>
            {CARDS.map((card) => {
              const selected = chosen === card.condition;
              return (
                <Pressable
                  key={card.condition}
                  onPress={() => set('displayCondition', card.condition)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${card.title}, ${card.caption}`}
                  style={[
                    styles.card,
                    {
                      borderColor: selected ? theme.colors.primary : tokens.outlineVariant,
                      borderWidth: selected ? 2 : 1,
                      backgroundColor: selected
                        ? theme.colors.secondaryContainer
                        : theme.colors.elevation.level1,
                    },
                  ]}
                >
                  <Icon
                    source={card.icon}
                    size={28}
                    color={selected ? theme.colors.onSecondaryContainer : ink}
                  />
                  <Text
                    style={[
                      styles.cardTitle,
                      { color: selected ? theme.colors.onSecondaryContainer : ink },
                    ]}
                  >
                    {card.title}
                  </Text>
                  <Text
                    style={[
                      styles.cardCaption,
                      { color: selected ? theme.colors.onSecondaryContainer : tokens.inkMuted },
                    ]}
                  >
                    {card.caption}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ToggleRow
            title="Auto night at sunset"
            caption={autoCaption}
            value={autoNight}
            onChange={(v) => set('autoNightAtSunset', v)}
          />
          <ToggleRow
            title="Sunlight while recording"
            caption="On while a recording is running"
            value={sunlightRecording}
            onChange={(v) => set('sunlightWhileRecording', v)}
          />

          <Text style={[styles.note, { color: tokens.inkMuted }]}>
            {Platform.OS === 'ios'
              ? 'For a true red-only screen, use iOS Colour Filters (Settings › Accessibility › Display & Text Size).'
              : "For a true red-only screen, use your phone's colour correction in the accessibility settings."}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function ToggleRow({
  title,
  caption,
  value,
  onChange,
}: {
  title: string;
  caption: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  return (
    <View style={[styles.toggleRow, { borderTopColor: tokens.divider }]}>
      <View style={styles.toggleText}>
        <Text style={[styles.toggleTitle, { color: theme.colors.onSurface }]}>{title}</Text>
        <Text style={[styles.toggleCaption, { color: tokens.inkMuted }]}>{caption}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={title} />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '85%' },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  subtitle: { fontSize: 14 },
  cards: { flexDirection: 'row', gap: 10, marginVertical: 8 },
  card: {
    flex: 1,
    minHeight: 112,
    borderRadius: 16,
    padding: 12,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardCaption: { fontSize: 12, fontWeight: '500' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  toggleText: { flex: 1 },
  toggleTitle: { fontSize: 16, fontWeight: '700' },
  toggleCaption: { fontSize: 13 },
  note: { fontSize: 12, marginTop: 4 },
});
