/**
 * The style popover (#683, mockup frame 3): colour (the eight member hues, no
 * red), pencil width and dash, arrow head and size, and the fade time. Set
 * once, kept on this phone, applied to the next shapes. A plain themed View
 * anchored over the tool bar, never a Portal (paper-portal-touch-swallow).
 */
import { FADE_CHOICES_MS, type DrawPrefs } from '@core/teamdraw/style';
import { MEMBER_COLORS } from '@core/teamui/colors';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { Icon, IconButton, Text, useTheme } from 'react-native-paper';

import { COLOUR_NAMES } from './drawShared';

/** "10 s", "5 min", "4 h", "Never". */
export function fadeLabel(ms: number | null): string {
  if (ms === null) return 'Never';
  if (ms < 60_000) return `${ms / 1000} s`;
  if (ms < 3_600_000) return `${ms / 60_000} min`;
  return `${ms / 3_600_000} h`;
}

function Seg<T>({
  items,
  value,
  onPick,
  label,
  testID,
  tight,
}: {
  items: readonly { v: T; node: ReactNode; a11y: string }[];
  value: T;
  onPick: (v: T) => void;
  label: string;
  testID: string;
  tight?: boolean;
}) {
  const t = useSchemeTokens();
  const { colors } = useTheme();
  return (
    <View
      style={[styles.seg, { backgroundColor: t.surfaceVariant }]}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {items.map((it, i) => {
        const on = it.v === value;
        return (
          <Pressable
            key={i}
            onPress={() => onPick(it.v)}
            style={[
              styles.segItem,
              tight && styles.segTight,
              on && { backgroundColor: colors.primary },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={it.a11y}
            testID={`${testID}-${i}`}
          >
            {typeof it.node === 'string' ? (
              <Text
                variant="labelMedium"
                style={{
                  color: on ? colors.onPrimary : t.inkVariant,
                  fontWeight: on ? '800' : '700',
                }}
                numberOfLines={1}
              >
                {it.node}
              </Text>
            ) : (
              <View style={{ opacity: on ? 1 : 0.8 }}>{it.node}</View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function Section({ children, right }: { children: string; right?: string }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.sec}>
      <Text style={[styles.secText, { color: t.inkMuted }]}>{children.toUpperCase()}</Text>
      {right ? <Text style={[styles.secRight, { color: t.inkMuted }]}>{right}</Text> : null}
    </View>
  );
}

export function DrawStylePopover({
  prefs,
  own,
  onChange,
  onClose,
  bottom,
}: {
  prefs: DrawPrefs;
  /** My member colour's index ("yours"). */
  own: number;
  onChange: (p: DrawPrefs) => void;
  onClose: () => void;
  bottom: number;
}) {
  const t = useSchemeTokens();
  const { colors } = useTheme();
  const set = (patch: Partial<DrawPrefs>) => onChange({ ...prefs, ...patch });
  const ink = (on: boolean) => (on ? colors.onPrimary : t.inkVariant);
  const widthIcon = (w: 1 | 2 | 3) => {
    const on = prefs.width === w;
    const sw = { 1: 3, 2: 5, 3: 8 }[w];
    return (
      <Svg width={22} height={12}>
        <Line
          x1={3}
          y1={6}
          x2={19}
          y2={6}
          stroke={ink(on)}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </Svg>
    );
  };
  const headIcon = (kind: DrawPrefs['head']) => {
    const c = ink(prefs.head === kind);
    if (kind === 'open')
      return (
        <Svg width={22} height={14}>
          <Path d="M2 7 H19 M13 2 L19 7 L13 12" stroke={c} strokeWidth={2.5} fill="none" />
        </Svg>
      );
    if (kind === 'both')
      return (
        <Svg width={24} height={14}>
          <Path d="M8 7 H16" stroke={c} strokeWidth={2.5} />
          <Path d="M23 7 L15 2 L15 12Z M1 7 L9 2 L9 12Z" fill={c} />
        </Svg>
      );
    return (
      <Svg width={22} height={14}>
        <Path d="M2 7 H12" stroke={c} strokeWidth={2.5} />
        <Path d="M20 7 L11 2 L11 12Z" fill={c} />
      </Svg>
    );
  };
  return (
    <View
      style={[
        styles.pop,
        {
          bottom,
          backgroundColor: t.surface,
          borderColor: t.outlineVariant,
          shadowColor: palette.shadow,
        },
      ]}
      testID="team-draw-style"
    >
      <View style={styles.head}>
        <Text variant="titleSmall" style={{ color: t.ink, fontWeight: '800' }}>
          Style
        </Text>
        <IconButton
          icon="close"
          size={20}
          onPress={onClose}
          accessibilityLabel="Close the style"
          testID="team-draw-style-close"
        />
      </View>
      <Section right={`yours: ${COLOUR_NAMES[own] ?? ''}`}>Colour</Section>
      <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Colour">
        {MEMBER_COLORS.map((c, i) => {
          const on = prefs.colour === i;
          return (
            <Pressable
              key={c}
              onPress={() => set({ colour: i })}
              hitSlop={4}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={COLOUR_NAMES[i]}
              testID={`team-draw-colour-${i}`}
              style={[styles.swatchRing, { borderColor: on ? t.ink : 'transparent' }]}
            >
              <View style={[styles.swatch, { backgroundColor: c }]}>
                {on && <Icon source="check" size={20} color={palette.white} />}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Section>Pencil</Section>
      <View style={styles.two}>
        <Seg
          label="Width"
          testID="team-draw-width"
          value={prefs.width}
          onPick={(width) => set({ width })}
          items={([1, 2, 3] as const).map((w) => ({
            v: w,
            node: widthIcon(w),
            a11y: ['Thin', 'Medium', 'Thick'][w - 1]!,
          }))}
        />
        <Seg
          label="Line"
          testID="team-draw-dash"
          value={prefs.dashed}
          onPick={(dashed) => set({ dashed })}
          items={[
            { v: false, node: 'Solid', a11y: 'Solid' },
            { v: true, node: 'Dashed', a11y: 'Dashed' },
          ]}
        />
      </View>
      <Section>Arrow head</Section>
      <View style={styles.two}>
        <Seg
          label="Arrow head"
          testID="team-draw-head"
          value={prefs.head}
          onPick={(head) => set({ head })}
          items={(['fill', 'open', 'both'] as const).map((h) => ({
            v: h,
            node: headIcon(h),
            a11y: { fill: 'Filled', open: 'Open', both: 'Both ends' }[h],
          }))}
        />
        <Seg
          label="Head size"
          testID="team-draw-headsize"
          value={prefs.headSize}
          onPick={(headSize) => set({ headSize })}
          items={([1, 2, 3] as const).map((s) => ({
            v: s,
            node: ['S', 'M', 'L'][s - 1]!,
            a11y: ['Small', 'Medium', 'Large'][s - 1]!,
          }))}
        />
      </View>
      <Section>Fades after</Section>
      <Seg
        label="Fades after"
        testID="team-draw-fade"
        tight
        value={prefs.fadeMs}
        onPick={(fadeMs) => set({ fadeMs })}
        items={FADE_CHOICES_MS.map((ms) => ({ v: ms, node: fadeLabel(ms), a11y: fadeLabel(ms) }))}
      />
      <View style={styles.foot}>
        <Icon source="history" size={15} color={t.inkMuted} />
        <Text variant="bodySmall" style={{ color: t.inkMuted }}>
          Applies to your next shapes. Kept on this phone.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pop: {
    position: 'absolute',
    left: 12,
    right: 12,
    maxWidth: 360,
    alignSelf: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 2,
    paddingBottom: 14,
    zIndex: 10,
    elevation: 10,
    shadowOpacity: 0.32,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sec: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, marginBottom: 5 },
  secText: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 1.1 },
  secRight: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  swatches: { flexDirection: 'row', justifyContent: 'space-between' },
  swatchRing: { borderWidth: 2, borderRadius: 22, padding: 2 },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  two: { flexDirection: 'row', gap: 8 },
  seg: { flex: 1, flexDirection: 'row', gap: 3, padding: 3, borderRadius: 11 },
  segItem: {
    flex: 1,
    minHeight: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  segTight: { paddingHorizontal: 0 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
});
