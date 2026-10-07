import type { ChipIcon, ChipTone, ReceiverChip } from '@core/gnss/chip';
import type { SchemeTokens } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

const ICONS: Record<ChipIcon, string> = {
  receiver: 'satellite-variant',
  phone: 'crosshairs-gps',
  'receiver-off': 'bluetooth-off',
};

/** Words and outline on a surface (the recording panel), by tone. */
function surfaceColors(t: SchemeTokens, tone: ChipTone) {
  switch (tone) {
    case 'fixed':
      return { ink: t.status.gnssFixed, border: t.status.gnssFixed, fill: 'transparent' };
    case 'dgps':
      return { ink: t.status.gnssDgps, border: t.status.gnssDgps, fill: 'transparent' };
    case 'float':
    case 'warn':
      return { ink: t.status.gpsWeak, border: t.status.gpsWeak, fill: 'transparent' };
    case 'lost':
      return { ink: t.status.onGpsLost, border: t.status.gpsLost, fill: t.status.gpsLost };
    default:
      return { ink: t.ink, border: t.outlineVariant, fill: 'transparent' };
  }
}

/** The state's icon on map chrome (the words stay `chromeInk`). */
function chromeIcon(t: SchemeTokens, tone: ChipTone): string {
  switch (tone) {
    case 'fixed':
      return t.map.gnssFixed;
    case 'dgps':
      return t.map.gnssDgps;
    case 'float':
    case 'warn':
      return t.map.gnssWarn;
    case 'lost':
      return t.map.gnssLost;
    default:
      return t.map.chromeInk;
  }
}

interface Props {
  chip: ReceiverChip;
  /** `surface`: the recording panel's outline chip; `chrome`: a pill floating on the map. */
  variant: 'surface' | 'chrome';
  onPress?: () => void;
  testID?: string;
}

/**
 * The external receiver's status chip (mockup `gnss-chips`): its words and
 * shape carry the state; colour only repeats it. Tapping opens the detail
 * sheet.
 */
export function ReceiverChipView({ chip, variant, onPress, testID }: Props) {
  const t = useSchemeTokens();
  const a11y = onPress ? `${chip.a11y}. Show receiver details` : chip.a11y;
  if (variant === 'surface') {
    const c = surfaceColors(t, chip.tone);
    return (
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : 'text'}
        accessibilityLabel={a11y}
        hitSlop={10}
        testID={testID}
        style={[
          styles.surfaceChip,
          { borderColor: c.border, backgroundColor: c.fill },
          chip.tone === 'lost' && styles.noBorder,
        ]}
      >
        <Icon source={ICONS[chip.icon]} size={14} color={c.ink} />
        <Text numberOfLines={1} style={[styles.surfaceText, { color: c.ink }]}>
          {chip.label}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={a11y}
      hitSlop={6}
      testID={testID}
      style={({ pressed }) => [
        styles.chromeChip,
        { backgroundColor: pressed ? t.map.chromeActive : t.map.chrome, shadowColor: t.map.chrome },
      ]}
    >
      <Icon source={ICONS[chip.icon]} size={16} color={chromeIcon(t, chip.tone)} />
      {/* Two lines: the state and accuracy, then satellites and correction age. */}
      <View style={styles.chromeText}>
        <Text numberOfLines={1} style={[styles.chromeLabel, { color: t.map.chromeInk }]}>
          {chip.label}
        </Text>
        {chip.detail !== null && (
          <Text numberOfLines={1} style={[styles.chromeDetail, { color: t.map.chromeInk }]}>
            {chip.detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The recording panel's chip metrics (RecordingPanel `chip`).
  surfaceChip: {
    height: 28,
    paddingHorizontal: 11,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  noBorder: { borderWidth: 0 },
  surfaceText: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], flexShrink: 1 },
  chromeChip: {
    minHeight: 40,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: '100%',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  chromeText: { flexShrink: 1 },
  chromeLabel: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], flexShrink: 1 },
  chromeDetail: {
    fontSize: 12,
    fontWeight: '500',
    opacity: 0.82,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
});
