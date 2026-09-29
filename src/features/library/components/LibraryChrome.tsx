import { ContourTexture } from '@ui/components/ContourTexture';
import { LIBRARY_TYPE_FILTERS, type LibraryTypeFilter } from '@core/library/libraryRows';
import { InukshukIcon } from '@features/map/components/InukshukIcon';
import { tabularNums } from '@ui/fonts';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode, Ref } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/**
 * The Library's chrome (revamp §5, boards `After-Library.html` and
 * `After-Empty.html`): contour texture, type chips, collapsible section
 * headers and the empty state. The rows live in `LibraryRows.tsx`.
 */

export { ContourTexture };

/** One chip in the row: "Maps 2". */
function Chip({
  label,
  count,
  on,
  onPress,
}: {
  label: string;
  count: number;
  on: boolean;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      style={styles.chipHit}
    >
      <View
        style={[
          styles.chip,
          on
            ? { backgroundColor: t.library.chipOn, borderColor: t.library.chipOn }
            : { backgroundColor: t.library.chip, borderColor: t.library.chipBorder },
        ]}
      >
        {/* One Text (nested count), so the chip is ONE string: "Maps 2"
            can never be mistaken for the "Maps" tab by a text match. */}
        <Text style={[styles.chipLabel, { color: on ? t.library.chipOnInk : t.library.chipInk }]}>
          {label}
          <Text
            style={[styles.chipCount, { color: on ? t.library.chipOnCount : t.library.chipCount }]}
          >
            {`\u2002${count}`}
          </Text>
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * All · Trails · Maps · Waypoints, each with its count; `trailing` sits after
 * the row. `extraChips` follow the type chips ("From Strava 39", #432) and
 * select independently: while one is on, no type chip is.
 */
export function TypeFilterChips({
  value,
  counts,
  onChange,
  trailing,
  extraChips = [],
  extraValue = null,
  onExtraChange,
}: {
  value: LibraryTypeFilter;
  counts: Record<LibraryTypeFilter, number>;
  onChange: (next: LibraryTypeFilter) => void;
  trailing?: ReactNode;
  extraChips?: readonly { id: string; label: string; count: number }[];
  extraValue?: string | null;
  onExtraChange?: (id: string) => void;
}) {
  return (
    <View style={styles.chipBar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        accessibilityRole="tablist"
        accessibilityLabel="Filter by type"
        style={styles.chipScroll}
      >
        {LIBRARY_TYPE_FILTERS.map(({ id, label }) => (
          <Chip
            key={id}
            label={label}
            count={counts[id]}
            on={extraValue === null && value === id}
            onPress={() => onChange(id)}
          />
        ))}
        {extraChips.map(({ id, label, count }) => (
          <Chip
            key={id}
            label={label}
            count={count}
            on={extraValue === id}
            onPress={() => onExtraChange?.(id)}
          />
        ))}
      </ScrollView>
      {trailing}
    </View>
  );
}

/**
 * A collapsible section (a folder, or Maps / Recorded trails / Waypoints):
 * chevron, 15/800 name, muted count. The count keeps its "(n)" / "(n/m)"
 * form — the e2e flows read it. `actions` (Organize mode's rename/delete)
 * sit OUTSIDE the toggle so iOS never folds them into its label.
 */
export function SectionHeader({
  title,
  count,
  collapsed,
  onToggle,
  actions,
  first,
  highlighted,
  dropRef,
}: {
  title: string;
  count: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  first?: boolean;
  highlighted?: boolean;
  dropRef?: Ref<View>;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <View
      ref={dropRef}
      style={[
        styles.sectionRow,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth * 2,
          borderTopColor: t.outlineVariant,
        },
        highlighted && { backgroundColor: theme.colors.secondaryContainer },
      ]}
    >
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        style={styles.sectionToggle}
      >
        <Icon source={collapsed ? 'chevron-right' : 'chevron-down'} size={20} color={t.ink} />
        <Text numberOfLines={1} style={[styles.sectionTitle, { color: t.ink }]}>
          {title}
          {count ? (
            <Text style={[styles.sectionCount, { color: t.inkMuted }]}>{` ${count}`}</Text>
          ) : null}
        </Text>
      </Pressable>
      {actions}
    </View>
  );
}

/** The first-run state (`After-Empty.html`). */
export function LibraryEmptyState({
  onRecord,
  onImportGpx,
  onBrowseMaps,
  busy,
}: {
  onRecord: () => void;
  onImportGpx: () => void;
  onBrowseMaps: () => void;
  busy: boolean;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.emptyWrap}>
      <ContourTexture variant="empty" top={40} />
      <View style={styles.empty}>
        <View
          style={[styles.emptyBadge, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
        >
          <InukshukIcon size={64} color={t.ink} />
        </View>
        <View style={styles.emptyText}>
          <Text accessibilityRole="header" style={[styles.emptyTitle, { color: t.ink }]}>
            No trails yet
          </Text>
          <Text style={[styles.emptyBody, { color: t.inkMuted }]}>
            Record one on the map, or import a GPX file you already have.
          </Text>
        </View>
        <View style={styles.emptyButtons}>
          <Pressable
            onPress={onRecord}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.bigButton,
              { backgroundColor: t.library.chipOn },
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.recordRing, { borderColor: t.library.chipOnInk }]}>
              <View style={[styles.recordDot, { backgroundColor: t.library.chipOnInk }]} />
            </View>
            <Text style={[styles.bigButtonLabel, { color: t.library.chipOnInk }]}>
              Record a trail
            </Text>
          </Pressable>
          <Pressable
            onPress={onImportGpx}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={({ pressed }) => [
              styles.bigButton,
              styles.outlined,
              { borderColor: t.ink },
              (pressed || busy) && styles.pressed,
            ]}
          >
            <Icon source="tray-arrow-down" size={18} color={t.ink} />
            <Text style={[styles.bigButtonLabel, { color: t.ink }]}>Import trails</Text>
          </Pressable>
        </View>
        <Pressable onPress={onBrowseMaps} accessibilityRole="link" style={styles.link}>
          <Text style={[styles.linkLabel, { color: t.ink }]}>Browse maps near you</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chipBar: { flexDirection: 'row', alignItems: 'center', paddingRight: space.xs },
  chipScroll: { flexGrow: 1, flexShrink: 1 },
  chipRow: { paddingLeft: space.lg, paddingRight: space.sm, gap: space.sm, alignItems: 'center' },
  chipHit: { height: target.min, justifyContent: 'center' },
  chip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  chipCount: { fontWeight: '500', ...tabularNums },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: target.min,
    paddingRight: space.xs,
  },
  sectionToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: target.min,
    paddingLeft: space.md,
    paddingRight: space.sm,
  },
  sectionTitle: { flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: '800' },
  sectionCount: { fontWeight: '500', ...tabularNums },
  emptyWrap: { flex: 1 },
  empty: {
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingTop: 100,
  },
  emptyBadge: {
    width: 112,
    height: 112,
    borderRadius: 56,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { alignItems: 'center', gap: space.sm },
  emptyTitle: { fontSize: 24, lineHeight: 30, fontWeight: '800', textAlign: 'center' },
  emptyBody: { fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 290 },
  emptyButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: space.sm,
    width: '100%',
  },
  bigButton: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 150,
    minHeight: 52,
    borderRadius: 26,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  outlined: { borderWidth: 1.5 },
  pressed: { opacity: 0.7 },
  bigButtonLabel: { fontSize: 16, lineHeight: 20, fontWeight: '700' },
  recordRing: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordDot: { width: 11, height: 11, borderRadius: 5.5 },
  link: { minHeight: target.min, justifyContent: 'center', paddingHorizontal: space.sm },
  linkLabel: { fontSize: 15, fontWeight: '700', textDecorationLine: 'underline' },
});
