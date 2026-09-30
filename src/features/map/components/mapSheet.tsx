import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Icon, IconButton, Switch, Text, TouchableRipple, useTheme } from 'react-native-paper';

/**
 * The visual language of the map's rail sheets (#484): the "Map type" panel
 * and the Overlays menu. A rounded, themed sheet (paper in light, stone
 * night in dark — never the old fixed dark slab), a bold title with a close
 * button, small-caps section titles, and rows of icon + one-line label +
 * optional one-line hint with the control on the right: a Switch, a chevron,
 * or a segmented level picker underneath.
 *
 * Plain themed Views throughout — never a Portal/Dialog (the invisible-
 * overlay soft-lock landmine) and never a Paper Surface (the absolutely-
 * positioned iOS flex collapse).
 */

/** Rows and segments never go below the 44 pt / 48 dp touch minimums. */
export const SHEET_ROW_MIN_H = 56;
/** Segment height; with its 4-dp slop above and below, a 46-dp target. */
const SEGMENT_H = 38;
const SEGMENT_SLOP = { top: 4, bottom: 4, left: 0, right: 0 };

/** Sheet width: the screen less the 16-dp map margins, capped for tablets. */
export function useSheetWidth(): number {
  const { width } = useWindowDimensions();
  return Math.min(width - 32, 400);
}

/** Selection accent (sage marks selection, see `@ui/theme`) and its ink. */
export function useSheetAccent(): { accent: string; onAccent: string } {
  const { colors } = useTheme();
  return { accent: colors.secondary, onAccent: colors.onSecondary };
}

export function MapSheet({
  children,
  style,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const tokens = useSchemeTokens();
  const width = useSheetWidth();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.sheet,
        { width, backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Title + close (✕). `closeLabel` is the Maestro/a11y handle of the sheet. */
export function SheetHeader({
  title,
  closeLabel,
  onClose,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const tokens = useSchemeTokens();
  return (
    <View style={styles.header}>
      <Text
        style={[styles.title, { color: tokens.ink }]}
        numberOfLines={1}
        accessibilityRole="header"
      >
        {title}
      </Text>
      <IconButton
        icon="close"
        size={20}
        iconColor={tokens.inkMuted}
        onPress={onClose}
        accessibilityLabel={closeLabel}
        style={styles.close}
      />
    </View>
  );
}

export function SectionTitle({ children }: { children: string }) {
  const tokens = useSchemeTokens();
  return (
    <Text style={[styles.section, { color: tokens.inkMuted }]} accessibilityRole="header">
      {children.toUpperCase()}
    </Text>
  );
}

/** The icon + label + hint block every row starts with. */
function RowText({ icon, label, hint }: { icon: string; label: string; hint?: string }) {
  const tokens = useSchemeTokens();
  return (
    <>
      <View style={styles.iconSlot}>
        <Icon source={icon} size={22} color={tokens.inkVariant} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: tokens.ink }]} numberOfLines={1}>
          {label}
        </Text>
        {hint !== undefined && (
          <Text style={[styles.hint, { color: tokens.inkMuted }]} numberOfLines={1}>
            {hint}
          </Text>
        )}
      </View>
    </>
  );
}

/**
 * A toggle row: the WHOLE row is the tap target and the accessible element
 * (role switch, `checked` state, the label as its name); the Switch on the
 * right is display only, hidden from the a11y tree so it neither doubles the
 * announcement nor steals the tap. `below` renders under the row (a slider or
 * a level picker that belongs to this toggle).
 */
export function SwitchRow({
  icon,
  label,
  hint,
  value,
  onToggle,
  disabled = false,
  accessibilityLabel,
  below,
}: {
  icon: string;
  label: string;
  hint?: string;
  value: boolean;
  onToggle: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  below?: ReactNode;
}) {
  const { accent } = useSheetAccent();
  return (
    <View>
      <TouchableRipple
        onPress={onToggle}
        disabled={disabled}
        accessible
        accessibilityRole="switch"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ checked: value, disabled }}
        style={styles.rowTouch}
        borderless
      >
        <View style={[styles.row, disabled && styles.dimmed]}>
          <RowText icon={icon} label={label} hint={hint} />
          <View
            pointerEvents="none"
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            <Switch value={value} color={accent} disabled={disabled} />
          </View>
        </View>
      </TouchableRipple>
      {below !== undefined && <View style={styles.below}>{below}</View>}
    </View>
  );
}

/** A drill-in / action row: label (+ hint) with a trailing chevron. */
export function NavRow({
  icon,
  label,
  hint,
  onPress,
  disabled = false,
  accessibilityLabel,
}: {
  icon: string;
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const tokens = useSchemeTokens();
  return (
    <TouchableRipple
      onPress={onPress}
      disabled={disabled}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      style={styles.rowTouch}
      borderless
    >
      <View style={[styles.row, disabled && styles.dimmed]}>
        <RowText icon={icon} label={label} hint={hint} />
        <Icon source="chevron-right" size={22} color={tokens.inkMuted} />
      </View>
    </TouchableRipple>
  );
}

/** A row whose control is a level picker underneath (no on/off of its own). */
export function LevelsRow<V extends string | number>({
  icon,
  label,
  hint,
  levels,
  selected,
  onSelect,
  disabled = false,
}: {
  icon: string;
  label: string;
  hint?: string;
  levels: readonly { value: V; label: string }[];
  selected: V;
  onSelect: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <View>
      <View style={[styles.row, styles.rowStatic, disabled && styles.dimmed]}>
        <RowText icon={icon} label={label} hint={hint} />
      </View>
      <View style={styles.below}>
        <Segmented levels={levels} selected={selected} onSelect={onSelect} disabled={disabled} />
      </View>
    </View>
  );
}

/**
 * A segmented level picker: equal segments on a quiet track, the selection
 * filled with the accent. Each segment is its own accessible button named by
 * its level (the Maestro flows and tests key on 'Heavy', '50 m', 'Auto', …).
 */
export function Segmented<V extends string | number>({
  levels,
  selected,
  onSelect,
  disabled = false,
}: {
  levels: readonly { value: V; label: string }[];
  selected: V;
  onSelect: (value: V) => void;
  disabled?: boolean;
}) {
  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  return (
    <View
      style={[
        styles.segTrack,
        { backgroundColor: tokens.surfaceVariant },
        disabled && styles.dimmed,
      ]}
    >
      {levels.map((l) => {
        const on = l.value === selected;
        return (
          <Pressable
            key={String(l.value)}
            onPress={() => onSelect(l.value)}
            disabled={disabled}
            hitSlop={SEGMENT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={l.label}
            accessibilityState={{ selected: on, disabled }}
            style={[styles.seg, on && { backgroundColor: accent }]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.segLabel,
                { color: on ? onAccent : tokens.inkVariant },
                on && styles.segLabelOn,
              ]}
            >
              {l.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingBottom: 8,
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 4,
  },
  title: { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: '800' },
  close: { margin: 0 },
  section: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1.1,
    marginTop: 12,
    marginBottom: 2,
    marginHorizontal: 16,
  },
  rowTouch: { borderRadius: 12, marginHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: SHEET_ROW_MIN_H,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  rowStatic: { marginHorizontal: 4, minHeight: 44, paddingBottom: 2 },
  iconSlot: { width: 24, alignItems: 'center' },
  // flex:1 is load-bearing: without it the label column shrinks to nothing
  // beside the icon (the old "label-less rows" bug).
  rowText: { flex: 1 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  hint: { fontSize: 12.5, lineHeight: 16 },
  dimmed: { opacity: 0.4 },
  // Indented to the label column (12 + 24 + 12 from the row edge).
  below: { paddingLeft: 52, paddingRight: 16, paddingBottom: 10 },
  segTrack: { flexDirection: 'row', borderRadius: 11, padding: 3, gap: 3 },
  seg: {
    flex: 1,
    minHeight: SEGMENT_H,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  segLabel: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  segLabelOn: { fontWeight: '800' },
});
