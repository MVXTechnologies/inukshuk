import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect } from 'react-native-svg';

/**
 * After a tip (#476, board `Thanks.dc.html`): a stone figure, thanks, and the
 * way back to what the person came for. Reached by `router.replace` from the
 * Support screen, so Back from here returns to Settings, not to the jar.
 */
export function SupportThanksScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = useSchemeTokens();
  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: t.background, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <Svg width={120} height={140} viewBox="0 0 120 140" accessibilityElementsHidden>
        <Rect x={44} y={8} width={32} height={24} rx={8} fill={t.support.stone} />
        <Rect x={14} y={38} width={92} height={20} rx={8} fill={t.support.stoneDeep} />
        <Rect x={36} y={62} width={48} height={30} rx={9} fill={t.support.stone} />
        <Rect x={30} y={96} width={24} height={38} rx={8} fill={t.support.stoneDeep} />
        <Rect x={66} y={96} width={24} height={38} rx={8} fill={t.support.stoneDeep} />
      </Svg>
      <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
        Thank you
      </Text>
      <Text style={[styles.body, { color: t.inkMuted }]}>
        Your tip keeps Inukshuk free for everyone who heads out after you. Safe travels on the
        trail.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.dismissTo('/')}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: t.support.accent },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.buttonLabel, { color: t.support.onAccent }]}>Back to the map</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingHorizontal: space.xxl,
  },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 16, lineHeight: 24, textAlign: 'center' },
  button: {
    marginTop: space.md,
    minHeight: 52,
    paddingHorizontal: space.xxl,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 17, fontWeight: '800' },
  pressed: { opacity: 0.75 },
});
