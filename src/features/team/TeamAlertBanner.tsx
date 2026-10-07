/**
 * The in-app banner for a teammate's message routed to me as `alert` or
 * `badge` (#589): over every screen, at the top, for a few seconds. A plain
 * absolutely positioned View with its own JS timer — never a Paper Portal or
 * Snackbar on this spontaneous path (paper-portal-touch-swallow,
 * paper-snackbar-sticks-on-samsung). Tapping it opens the chat.
 *
 * `badge` messages show only when they are urgent enough to interrupt
 * (important or from an admin); plain chatter just counts as unread.
 */
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { usePathname, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SHOW_MS = 6_000;

export function TeamAlertBanner() {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const path = usePathname();
  const banner = useTeamStore((s) => s.banner);
  const dismiss = useTeamStore((s) => s.dismissBanner);

  useEffect(() => {
    if (banner === null) return;
    const id = setTimeout(dismiss, SHOW_MS);
    return () => clearTimeout(id);
  }, [banner, dismiss]);

  const show =
    banner !== null && (banner.level === 'alert' || banner.priority > 0) && path !== '/team/chat';
  if (!show || banner === null) return null;
  const urgent = banner.priority === 2;
  return (
    <View style={[styles.wrap, { top: insets.top + 8 }]} pointerEvents="box-none">
      <Pressable
        onPress={() => {
          dismiss();
          router.push('/team/chat');
        }}
        style={[
          styles.banner,
          {
            backgroundColor: t.elevation.level3,
            borderColor: urgent ? t.status.gpsLostInk : t.outlineVariant,
            shadowColor: palette.shadow,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${banner.authorName}: ${banner.text}`}
        testID="team-alert-banner"
      >
        <Icon
          source={urgent ? 'alert' : 'message-text'}
          size={20}
          color={urgent ? t.status.gpsLostInk : t.ink}
        />
        <View style={styles.flex}>
          <Text variant="labelLarge" style={{ color: t.ink }} numberOfLines={1}>
            {urgent ? 'URGENT · ' : ''}
            {banner.authorName} · {banner.teamName}
          </Text>
          <Text variant="bodyMedium" style={{ color: t.ink }} numberOfLines={2}>
            {banner.text}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { position: 'absolute', left: 12, right: 12 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
