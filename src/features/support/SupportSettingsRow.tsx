import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/**
 * The accent card at the top of Settings (#476, board `Entry.dc.html`) that
 * opens Support Inukshuk.
 */
export function SupportSettingsRow() {
  const router = useRouter();
  const t = useSchemeTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Support Inukshuk. Free, no ads. Kept alive by donations."
      onPress={() => router.push('/support')}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: t.support.accent },
        pressed && styles.pressed,
      ]}
    >
      <Icon source="heart-outline" size={24} color={t.support.onAccent} />
      <View style={styles.text}>
        <Text style={[styles.title, { color: t.support.onAccent }]}>Support Inukshuk</Text>
        <Text style={[styles.subtitle, { color: t.support.onAccent }]}>
          Free, no ads. Kept alive by donations.
        </Text>
      </View>
      <Icon source="chevron-right" size={20} color={t.support.onAccent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    minHeight: 56,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  subtitle: { fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.85 },
});
