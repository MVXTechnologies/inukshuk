import { HeaderAction } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The receiver extension's sub-screens: a back header and a scrolling body. */
export function GnssScreenFrame({
  title,
  children,
  footer,
  testID,
}: {
  title: string;
  children: ReactNode;
  /** Pinned under the scroll (Save / Cancel). */
  footer?: ReactNode;
  testID?: string;
}) {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View
      style={[styles.fill, { backgroundColor: t.background, paddingTop: insets.top }]}
      testID={testID}
    >
      <View style={styles.header}>
        <HeaderAction icon="arrow-left" onPress={() => router.back()} accessibilityLabel="Back" />
        <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
          {title}
        </Text>
      </View>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {footer !== undefined && (
        <View
          style={[
            styles.footer,
            { paddingBottom: insets.bottom + space.sm, borderTopColor: t.outlineVariant },
          ]}
        >
          {footer}
        </View>
      )}
    </View>
  );
}

/** A section heading inside a sub-screen ("NEARBY · BLUETOOTH LE"). */
export function SectionLabel({ children }: { children: string }) {
  const t = useSchemeTokens();
  return (
    <Text style={[styles.section, { color: t.inkVariant }]} accessibilityRole="header">
      {children.toUpperCase()}
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.xs,
    paddingRight: space.sm,
    gap: space.xs,
  },
  title: { flex: 1, fontSize: 22, lineHeight: 28, fontWeight: '800' },
  body: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.md },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  section: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, marginTop: space.sm },
});
