import { ORG_MAPS_CONTACT_EMAIL, ORG_MAPS_COPY, orgMapsIssueUrl } from '@core/catalog/contribute';
import { radius, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/** How long the Copy button reads "Copied". */
export const COPIED_FEEDBACK_MS = 2000;

/**
 * "Your organisation's maps aren't here?" — the card closing Explore's
 * landing and lists. The address is plain selectable text with a Copy button
 * beside it (a `mailto:` link silently does nothing on a phone with no mail
 * app), plus a prefilled GitHub issue as a second path. Copy lives in
 * `@core/catalog/contribute`.
 */
export function OrganisationMapsCta({ style }: { style?: StyleProp<ViewStyle> }) {
  const t = useSchemeTokens();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    void Clipboard.setStringAsync(ORG_MAPS_CONTACT_EMAIL).catch(() => undefined);
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <View
      testID="org-maps-cta"
      style={[styles.card, { backgroundColor: t.surface, borderColor: t.outlineVariant }, style]}
    >
      <View style={styles.head}>
        <View style={[styles.glyph, { backgroundColor: t.explore.collectionBadge }]}>
          <Icon source="map-plus" size={22} color={t.explore.collectionBadgeInk} />
        </View>
        <View style={styles.headText}>
          <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
            {ORG_MAPS_COPY.title}
          </Text>
          <Text style={[styles.body, { color: t.inkMuted }]}>{ORG_MAPS_COPY.body}</Text>
        </View>
      </View>

      <View style={[styles.emailRow, { backgroundColor: t.surfaceVariant }]}>
        <Text
          selectable
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
          style={[styles.email, { color: t.ink }]}
        >
          {ORG_MAPS_CONTACT_EMAIL}
        </Text>
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Email address copied' : 'Copy the email address'}
          hitSlop={target.compactHitSlop}
          style={({ pressed }) => [styles.copy, pressed && styles.pressed]}
        >
          <Icon source={copied ? 'check' : 'content-copy'} size={16} color={t.explore.accent} />
          <Text style={[styles.action, { color: t.explore.accent }]}>
            {copied ? ORG_MAPS_COPY.copied : ORG_MAPS_COPY.copy}
          </Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => void Linking.openURL(orgMapsIssueUrl()).catch(() => undefined)}
        accessibilityRole="link"
        accessibilityLabel="Suggest a map source on GitHub"
        hitSlop={target.compactHitSlop}
        style={({ pressed }) => [styles.github, pressed && styles.pressed]}
      >
        <Text style={[styles.action, { color: t.explore.accent }]}>{ORG_MAPS_COPY.github}</Text>
        <Icon source="open-in-new" size={15} color={t.explore.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 14,
    gap: space.md,
  },
  head: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  glyph: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  body: { fontSize: 13, lineHeight: 18 },
  emailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingLeft: space.md,
    paddingRight: space.xs,
    minHeight: target.min,
  },
  email: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, fontWeight: '600' },
  copy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: target.min,
    paddingHorizontal: space.sm,
  },
  github: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    minHeight: target.compact,
  },
  action: { fontSize: 14, lineHeight: 19, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
