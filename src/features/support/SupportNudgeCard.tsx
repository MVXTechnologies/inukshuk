import { SUPPORT_NUDGE_ENABLED } from '@core/features/flags';
import { supportNudgeCount } from '@core/support/nudge';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

/**
 * The optional once-a-year card at the top of the Library (#476, board
 * `Entry.dc.html`). Rules in `@core/support/nudge`; OFF unless the build flag
 * `SUPPORT_NUDGE_ENABLED` is on. Either answer hides it for 12 months.
 */
export function SupportNudgeCard({ enabled = SUPPORT_NUDGE_ENABLED }: { enabled?: boolean }) {
  const router = useRouter();
  const t = useSchemeTokens();
  const tracks = useLibraryStore((s) => s.tracks);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const answeredAt = useSettingsStore((s) => s.supportNudgeAnsweredAt);
  const set = useSettingsStore((s) => s.set);
  // Mount time is precise enough: the rule counts in years. (An answer stamped
  // after it reads as "just answered", which hides the card at once.)
  const [now] = useState(Date.now);

  const count = useMemo(
    () =>
      // Before settings are read the answer date is unknown: never flash the card.
      hydrated ? supportNudgeCount({ enabled, tracks, now, lastAnsweredAt: answeredAt }) : null,
    [enabled, hydrated, tracks, answeredAt, now],
  );
  if (count === null) return null;

  const answer = () => set('supportNudgeAnsweredAt', Date.now());

  return (
    <View
      style={[styles.card, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
      testID="support-nudge"
    >
      <Text style={[styles.body, { color: t.ink }]}>
        <Text style={styles.bold}>You recorded {count} outings with Inukshuk this year.</Text> It
        stays free thanks to people like you. Would you chip in?
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            answer();
            router.push('/support');
          }}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t.support.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.buttonLabel, { color: t.support.onAccent }]}>Support</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={answer}
          style={({ pressed }) => [
            styles.button,
            styles.outlined,
            { borderColor: t.outlineVariant },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.buttonLabel, styles.notNow, { color: t.ink }]}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.sm,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
  },
  body: { fontSize: 15, lineHeight: 22 },
  bold: { fontWeight: '800' },
  actions: { flexDirection: 'row', gap: space.sm },
  button: {
    flex: 1,
    minHeight: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlined: { borderWidth: 1.5 },
  buttonLabel: { fontSize: 15, fontWeight: '800' },
  notNow: { fontWeight: '700' },
  pressed: { opacity: 0.8 },
});
