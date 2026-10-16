import { ContourTexture } from '@ui/components/ContourTexture';
import { LIBRARY_TYPE_FILTERS, type LibraryTypeFilter } from '@core/library/libraryRows';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';
import { tabularNums } from '@ui/fonts';
import { palette, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode, Ref } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

import { SelectCheck } from './LibraryRows';

/**
 * The Library's chrome (revamp §5, boards `After-Library.html` and
 * `After-Empty.html`): contour texture, type chips, collapsible section
 * headers and the empty state. The rows live in `LibraryRows.tsx`.
 */

export { ContourTexture };

/** A shared folder's header extras (#712). */
export interface SectionLive {
  line: string;
  tone: 'ok' | 'wait' | 'join';
  faces: readonly { id: string; initials: string; color: string }[];
  onMenu?: () => void;
}

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
  onLongPress,
  selected,
  actions,
  first,
  highlighted,
  dropRef,
  live,
  depth = 0,
}: {
  title: string;
  count: string;
  collapsed: boolean;
  onToggle: () => void;
  /** A folder's header: holding it selects the folder itself (#711). */
  onLongPress?: () => void;
  /** The folder is selected: sage fill and the circle check. */
  selected?: boolean;
  actions?: ReactNode;
  first?: boolean;
  highlighted?: boolean;
  dropRef?: Ref<View>;
  /** A shared folder (#712): its icon, sync line, faces and ⋮ (its own sheet). */
  live?: SectionLive;
  /** A sub-folder's depth (#712): indented under its parent. */
  depth?: number;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const lineColor =
    live?.tone === 'wait'
      ? t.status.pausedInk
      : live?.tone === 'ok'
        ? t.status.gnssFixed
        : t.inkMuted;
  return (
    <View
      ref={dropRef}
      style={[
        styles.sectionRow,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth * 2,
          borderTopColor: t.outlineVariant,
        },
        (highlighted || selected) && { backgroundColor: theme.colors.secondaryContainer },
      ]}
    >
      <Pressable
        onPress={onToggle}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed, ...(selected ? { selected: true } : {}) }}
        accessibilityHint={onLongPress ? 'Long-press to select the folder' : undefined}
        style={[styles.sectionToggle, depth > 0 && { paddingLeft: space.md + depth * 16 }]}
      >
        <Icon source={collapsed ? 'chevron-right' : 'chevron-down'} size={20} color={t.ink} />
        {live !== undefined && (
          <Icon source="folder-account" size={20} color={theme.colors.primary} />
        )}
        <View style={styles.sectionText}>
          <Text numberOfLines={1} style={[styles.sectionTitle, { color: t.ink }]}>
            {title}
            {count ? (
              <Text style={[styles.sectionCount, { color: t.inkMuted }]}>{` ${count}`}</Text>
            ) : null}
          </Text>
          {live !== undefined && (
            <View style={styles.liveLine}>
              {live.tone === 'join' ? (
                <ActivityIndicator size={12} color={theme.colors.primary} />
              ) : (
                <Icon
                  source={live.tone === 'wait' ? 'cloud-off-outline' : 'cloud-check-outline'}
                  size={15}
                  color={lineColor}
                />
              )}
              <Text
                numberOfLines={1}
                style={[styles.liveText, { color: live.tone === 'join' ? t.inkMuted : lineColor }]}
              >
                {live.line}
              </Text>
            </View>
          )}
        </View>
      </Pressable>
      {live !== undefined && live.faces.length > 0 && (
        <View style={styles.faces} accessibilityElementsHidden importantForAccessibility="no">
          {live.faces.slice(0, 2).map((f, i) => (
            <View
              key={f.id}
              style={[
                styles.face,
                { backgroundColor: f.color, borderColor: t.background },
                i > 0 && styles.faceOverlap,
              ]}
            >
              <Text style={styles.faceText}>{f.initials}</Text>
            </View>
          ))}
        </View>
      )}
      {live?.onMenu !== undefined && (
        <Pressable
          onPress={live.onMenu}
          accessibilityRole="button"
          accessibilityLabel={`${title}: shared folder options`}
          testID="library-shared-menu"
          style={styles.liveMenu}
        >
          <Icon source="dots-vertical" size={22} color={t.inkMuted} />
        </Pressable>
      )}
      {actions}
      {selected && <SelectCheck selected />}
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
          <InukshukGlyph size={64} frame="square" />
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
  sectionText: { flex: 1, minWidth: 0 },
  liveLine: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  liveText: { flexShrink: 1, fontSize: 12.5, lineHeight: 17, fontWeight: '700' },
  faces: { flexDirection: 'row', marginRight: space.xs },
  face: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceOverlap: { marginLeft: -8 },
  faceText: { fontSize: 9.5, fontWeight: '800', color: palette.white },
  liveMenu: { width: 44, minHeight: target.min, alignItems: 'center', justifyContent: 'center' },
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
