import { findCategory, type CustomCategory } from '@core/library/categories';
import { radius, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/**
 * Shared controls of the Logbook statistics screens: the activity chips, a
 * full-width segmented control, the card shell and a navigation row.
 */

/** "All" then one chip per activity the user has (`@core/stats/periods` activityChips). */
export function ActivityChips({
  ids,
  selected,
  onSelect,
  customCategories,
  includeAll = true,
}: {
  ids: readonly string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  customCategories: readonly CustomCategory[];
  includeAll?: boolean;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const chip = (key: string, id: string | null, label: string, icon?: string, color?: string) => {
    const on = selected === id;
    return (
      <Pressable
        key={key}
        onPress={() => onSelect(id)}
        hitSlop={target.compactHitSlop}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.chip,
          on
            ? {
                backgroundColor: theme.colors.secondaryContainer,
                borderColor: theme.colors.secondary,
              }
            : { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
          pressed && styles.pressed,
        ]}
      >
        {icon !== undefined && <Icon source={icon} size={16} color={color ?? tokens.ink} />}
        <Text style={[styles.chipText, { color: tokens.ink }]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="radiogroup"
      accessibilityLabel="Activity"
      style={styles.scroller}
      contentContainerStyle={styles.chipRow}
    >
      {includeAll && chip('all', null, 'All')}
      {ids.map((id) => {
        const c = findCategory(id, customCategories);
        return c === null ? null : chip(id, id, c.name, c.icon, c.color);
      })}
    </ScrollView>
  );
}

/** A full-width segmented control (44 dp segments). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segment, { backgroundColor: tokens.elevation.level3 }]}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            style={[styles.segmentButton, active && { backgroundColor: theme.colors.primary }]}
          >
            <Text
              numberOfLines={1}
              style={[styles.segmentText, { color: active ? theme.colors.onPrimary : tokens.ink }]}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The statistics card shell: surface, hairline, rounded. */
export function StatsCard({
  children,
  style,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  const tokens = useSchemeTokens();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.card,
        { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Caps label above a section ("FASTEST", "BIGGEST OUTINGS"). */
export function SectionLabel({ children }: { children: string }) {
  const tokens = useSchemeTokens();
  return (
    <Text accessibilityRole="header" style={[styles.caps, { color: tokens.inkMuted }]}>
      {children}
    </Text>
  );
}

/** A row that opens another screen ("Personal records ›"). */
export function LinkRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  const tokens = useSchemeTokens();
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={({ pressed }) => [
        styles.link,
        { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.linkIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
        <Icon source={icon} size={20} color={theme.colors.onSecondaryContainer} />
      </View>
      <View style={styles.linkText}>
        <Text style={[styles.linkTitle, { color: tokens.ink }]}>{title}</Text>
        {subtitle !== undefined && (
          <Text numberOfLines={1} style={[styles.linkSub, { color: tokens.inkMuted }]}>
            {subtitle}
          </Text>
        )}
      </View>
      <Icon source="chevron-right" size={22} color={tokens.inkMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroller: { marginHorizontal: -space.lg, flexGrow: 0 },
  chipRow: { paddingHorizontal: space.lg, paddingVertical: target.compactHitSlop, gap: 6 },
  chip: {
    height: target.compact,
    borderRadius: target.compact / 2,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipText: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  pressed: { opacity: 0.8 },
  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 2 },
  segmentButton: {
    flex: 1,
    height: target.min,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: 8,
  },
  caps: { fontSize: 12, lineHeight: 16, fontWeight: '800', letterSpacing: 1, marginTop: 6 },
  link: {
    minHeight: 60,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  linkIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkText: { flex: 1, minWidth: 0 },
  linkTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  linkSub: { fontSize: 12, lineHeight: 16 },
});
