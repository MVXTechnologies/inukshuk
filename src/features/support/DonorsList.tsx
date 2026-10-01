import { donorLine, donorOfferVisible } from '@core/support/donors';
import { useSupportStore } from '@state/supportStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useShallow } from 'zustand/react/shallow';

import { useSupportCosts } from './useSupportCosts';

/**
 * Settings › System info: "Prominent donors" (#476), the names published in
 * `costs.json` by the owner. Nothing shows while the list is empty (or
 * unreachable) — except, for someone whose own tips qualify, the way to add
 * their name.
 */
export function DonorsList() {
  const router = useRouter();
  const t = useSchemeTokens();
  const costs = useSupportCosts();
  const ledger = useSupportStore(
    useShallow((s) => ({
      totalCents: s.totalCents,
      tipCount: s.tipCount,
      transactionIds: s.transactionIds,
      donorSubmitted: s.donorSubmitted,
    })),
  );
  const donors = costs?.donors ?? [];
  const canAdd = donorOfferVisible(ledger);
  if (donors.length === 0 && !canAdd) return null;

  return (
    <View style={styles.wrap} testID="donors-list">
      {donors.length > 0 && (
        <>
          <Text accessibilityRole="header" style={[styles.heading, { color: t.ink }]}>
            Prominent donors
          </Text>
          <Text style={[styles.caption, { color: t.inkMuted }]}>
            People whose gifts keep Inukshuk free, listed with their permission. Thank you.
          </Text>
          <View
            style={[styles.card, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
          >
            {donors.map((donor, i) => {
              const line = donorLine(donor);
              return (
                <View
                  key={`${donor.name}-${i}`}
                  style={[
                    styles.row,
                    i < donors.length - 1 && {
                      borderBottomColor: t.outlineVariant,
                      borderBottomWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <Icon source="hand-heart-outline" size={20} color={t.support.link} />
                  <View style={styles.rowText}>
                    <Text style={[styles.name, { color: t.ink }]}>{donor.name}</Text>
                    {line !== '' && (
                      <Text style={[styles.caption, { color: t.inkMuted }]}>{line}</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        </>
      )}
      {canAdd && (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push('/support/donor')}
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}
          hitSlop={8}
        >
          <Text style={[styles.linkText, { color: t.support.link }]}>
            Add your name to the donors list →
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: 6 },
  heading: { fontSize: 16, lineHeight: 22, fontWeight: '800' },
  caption: { fontSize: 13, lineHeight: 18 },
  card: { marginTop: 4, borderRadius: 14, borderWidth: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  rowText: { flex: 1, gap: 1 },
  name: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.75 },
});
