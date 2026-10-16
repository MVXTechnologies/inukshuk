/**
 * Small pieces the note screens share (#706, mockups `#f706`): the segmented
 * "Fades after" choice, the colour swatches, the time-left ring, and the card
 * facts and actions (the teammate card's look). Plain themed Views.
 */
import { NOTE_FADES, type NoteFade } from '@core/domains/team/notes';
import { MEMBER_COLORS, memberColor } from '@core/teamui/colors';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Svg, { Circle } from 'react-native-svg';

/** Swatches a note offers: my member colour first, then the others, seven in all. */
export function noteSwatches(own: number): number[] {
  const rest = MEMBER_COLORS.map((_, i) => i).filter((i) => i !== own);
  return [own, ...rest].slice(0, 7);
}

export const noteColor = (i: number): string => memberColor(i);

export function FadeChoice({
  value,
  onChange,
  testIDPrefix = 'note-fade',
}: {
  value: NoteFade;
  onChange: (f: NoteFade) => void;
  testIDPrefix?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.seg, { borderColor: t.outline }]} accessibilityRole="radiogroup">
      {NOTE_FADES.map((f, i) => {
        const on = f.id === value;
        return (
          <Pressable
            key={f.id}
            onPress={() => onChange(f.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Fades after ${f.label}`}
            testID={`${testIDPrefix}-${f.id}`}
            style={[
              styles.segItem,
              i > 0 && { borderLeftWidth: 1, borderLeftColor: t.outline },
              on && { backgroundColor: t.support.selected },
            ]}
          >
            {on && <Icon source="check" size={16} color={t.ink} />}
            <Text style={[styles.segText, { color: t.ink }]} numberOfLines={1}>
              {f.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Swatches({
  options,
  value,
  onChange,
}: {
  options: readonly number[];
  value: number;
  onChange: (c: number) => void;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup">
      {options.map((c) => {
        const on = c === value;
        return (
          <Pressable
            key={c}
            onPress={() => onChange(c)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Colour ${c + 1}`}
            testID={`note-colour-${c}`}
            hitSlop={4}
            style={[styles.swatchRing, { borderColor: on ? t.ink : 'transparent' }]}
          >
            <View style={[styles.swatch, { backgroundColor: noteColor(c) }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** The time-left ring: `left` of the life (0–1) in `color`, the rest faint. */
export function LifeRing({
  left,
  color,
  size = 18,
}: {
  left: number;
  color: string;
  size?: number;
}) {
  const t = useSchemeTokens();
  const r = (size - 3) / 2;
  const len = 2 * Math.PI * r;
  const k = Math.min(1, Math.max(0, left));
  return (
    <Svg width={size} height={size} accessibilityElementsHidden importantForAccessibility="no">
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={t.outlineVariant}
        strokeWidth={3}
        fill="none"
      />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={3}
        fill="none"
        strokeDasharray={`${len * k} ${len}`}
        strokeLinecap="butt"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  const t = useSchemeTokens();
  return <View style={[styles.facts, { borderColor: t.outlineVariant }]}>{children}</View>;
}

export function Fact({
  label,
  value,
  lead,
  divider,
  testID,
}: {
  label: string;
  value: string;
  lead?: ReactNode;
  divider?: boolean;
  testID?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.fact, divider && { borderLeftWidth: 1, borderLeftColor: t.outlineVariant }]}
      accessible
      accessibilityLabel={`${label}: ${value}`}
      testID={testID}
    >
      <Text style={[styles.factLabel, { color: t.inkMuted }]}>{label}</Text>
      <View style={styles.factRow}>
        {lead}
        <Text style={[styles.factValue, { color: t.ink }]} numberOfLines={1}>
          {value}
        </Text>
      </View>
    </View>
  );
}

export function CardAct({
  icon,
  label,
  onPress,
  testID,
  primary = false,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
}) {
  const t = useSchemeTokens();
  const bg = primary ? t.support.accent : t.surfaceVariant;
  const ink = primary ? t.support.onAccent : t.ink;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.act, { backgroundColor: bg }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Icon source={icon} size={22} color={ink} />
      <Text style={[styles.actText, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

export const noteStyles = StyleSheet.create({
  /** The bottom sheet over the map (mockup `.sheet`). */
  sheet: {
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  t1: { fontSize: 18, lineHeight: 23, fontWeight: '800' },
  t2: { fontSize: 13, fontWeight: '600', marginTop: 1 },
  acts: { flexDirection: 'row', gap: 8 },
});

const styles = StyleSheet.create({
  seg: {
    flex: 1,
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 20,
    overflow: 'hidden',
    height: 38,
  },
  segItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  segText: { fontSize: 13.5, fontWeight: '700' },
  swatches: { flex: 1, flexDirection: 'row', gap: 6 },
  swatchRing: { borderWidth: 2, borderRadius: 17, padding: 2 },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  facts: { flexDirection: 'row', marginVertical: 12, borderWidth: 1, borderRadius: 16 },
  fact: { flex: 1, paddingHorizontal: 12, paddingVertical: 8 },
  factLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
  factRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  factValue: { fontSize: 15, fontWeight: '800' },
  act: {
    flex: 1,
    height: 58,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  actText: { fontSize: 13, fontWeight: '800' },
});
