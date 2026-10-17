import {
  WAYPOINT_ICON_GROUP_LIST,
  searchWaypointIcons,
  waypointIconLabel,
} from '@core/library/waypointIcons';
import type { WaypointIcon } from '@core/models';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Icon, IconButton, Text } from '@ui/paper';

import { ICON_TILE_HEIGHT, IconTile } from './IconTile';
import { useScaledStyles } from '@ui/displayScale';

const COLUMNS = 5;
const HEADER_H = 34;
const ROW_H = ICON_TILE_HEIGHT + 6;

type Row =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'tiles'; key: string; icons: (WaypointIcon | undefined)[] };

interface Section {
  id: string;
  chip: string | null;
  title: string;
  icons: (WaypointIcon | undefined)[];
}

/** Sections → flat rows of headers and five-tile rows (fixed heights, so jumps are exact). */
function toRows(sections: readonly Section[]): { rows: Row[]; starts: Map<string, number> } {
  const rows: Row[] = [];
  const starts = new Map<string, number>();
  for (const s of sections) {
    if (s.icons.length === 0) continue;
    starts.set(s.id, rows.length);
    // Untitled (the search results): no header row — an empty 34 dp row put
    // the results that much below the count (2.5.1 QA).
    if (s.title !== '') rows.push({ kind: 'header', key: `h-${s.id}`, title: s.title });
    for (let i = 0; i < s.icons.length; i += COLUMNS) {
      rows.push({ kind: 'tiles', key: `${s.id}-${i}`, icons: s.icons.slice(i, i + COLUMNS) });
    }
  }
  return { rows, starts };
}

interface Props {
  value: WaypointIcon | undefined;
  favorites: readonly WaypointIcon[];
  recents: readonly WaypointIcon[];
  /** Pick an icon (`undefined` = the default pin); the editor then returns. */
  onPick: (icon: WaypointIcon | undefined) => void;
  onToggleFavorite: (icon: WaypointIcon) => void;
  onBack: () => void;
  /** Sheet content width, for the five-column grid. */
  width: number;
}

/**
 * The full icon picker (#675): the editor sheet's second page, with a back
 * row (sub-panel rule: it belongs to this one waypoint, so it is a page of
 * its sheet, not a separate dialog). About 350 MaterialCommunityIcons in
 * groups, jump chips, a search over names and English/French synonyms, and
 * the user's starred favourites (owner addition) on top, then recents.
 *
 * A virtualized list of fixed-height rows: only what is on screen mounts
 * (≈ 40 tiles), not 350.
 */
export function WaypointIconPickerPage({
  value,
  favorites,
  recents,
  onPick,
  onToggleFavorite,
  onBack,
  width,
}: Props) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const [query, setQuery] = useState('');
  const list = useRef<FlatList<Row>>(null);
  const tileW = Math.floor((width - 24) / COLUMNS);
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const results = useMemo(() => searchWaypointIcons(query), [query]);
  const searching = query.trim() !== '';

  const { rows, starts, chips } = useMemo(() => {
    const sections: Section[] = searching
      ? [{ id: 'results', chip: null, title: '', icons: results.map((r) => r.id) }]
      : [
          { id: 'favorites', chip: 'Favourites', title: 'Favourites', icons: [...favorites] },
          { id: 'recents', chip: 'Recent', title: 'Recent', icons: [...recents] },
          { id: 'default', chip: null, title: 'Default', icons: [undefined] },
          ...WAYPOINT_ICON_GROUP_LIST.map((g) => ({
            id: g.id,
            chip: g.chip,
            title: g.label,
            icons: g.icons.map((i) => i.id),
          })),
        ];
    const flat = toRows(sections);
    return {
      ...flat,
      chips: sections.filter((s) => s.chip !== null && s.icons.length > 0),
    };
  }, [searching, results, favorites, recents]);

  // #760: the rows' heights at the Display size (the scaled sheet's own values).
  const headerH = (styles.header.height as number | undefined) ?? HEADER_H;
  const rowH = (styles.row.height as number | undefined) ?? ROW_H;
  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = 0;
    for (const r of rows) {
      out.push(y);
      y += r.kind === 'header' ? headerH : rowH;
    }
    return out;
  }, [rows, headerH, rowH]);

  const jump = useCallback(
    (id: string) => {
      const index = starts.get(id);
      if (index !== undefined) list.current?.scrollToIndex({ index, animated: true });
    },
    [starts],
  );

  const renderRow = useCallback(
    ({ item }: { item: Row }) =>
      item.kind === 'header' ? (
        <Text
          style={[styles.header, { color: tokens.inkMuted }]}
          accessibilityRole="header"
          numberOfLines={1}
        >
          {item.title.toUpperCase()}
        </Text>
      ) : (
        <View style={styles.row}>
          {item.icons.map((icon) => (
            <IconTile
              key={icon ?? 'default'}
              icon={icon}
              label={waypointIconLabel(icon)}
              selected={icon === value}
              width={tileW}
              onPress={onPick}
              favorite={icon !== undefined && favSet.has(icon)}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </View>
      ),
    [styles, tokens.inkMuted, value, tileW, onPick, favSet, onToggleFavorite],
  );

  return (
    <View style={styles.page}>
      <View style={styles.back}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to waypoint"
          style={styles.backButton}
          hitSlop={8}
        >
          <Icon source="chevron-left" size={24} color={tokens.ink} />
          <Text style={[styles.backLabel, { color: tokens.ink }]}>Icon</Text>
        </Pressable>
        <Text style={[styles.current, { color: tokens.inkMuted }]} numberOfLines={1}>
          {waypointIconLabel(value)}
        </Text>
      </View>

      <View style={[styles.search, { backgroundColor: tokens.surfaceVariant }]}>
        <Icon source="magnify" size={22} color={tokens.inkVariant} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search 300+ icons"
          placeholderTextColor={tokens.inkMuted}
          accessibilityLabel="Search icons"
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[styles.searchInput, { color: tokens.ink }]}
        />
        {searching && (
          <IconButton
            icon="close"
            size={18}
            onPress={() => setQuery('')}
            accessibilityLabel="Clear search"
            style={styles.clear}
          />
        )}
      </View>

      {searching ? (
        <Text style={[styles.count, { color: tokens.inkMuted }]} accessibilityLiveRegion="polite">
          {results.length === 1 ? '1 icon' : `${results.length} icons`}
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // A ScrollView grows by default (flexGrow 1): in this column it took
          // half the page as blank space above the list (2.5.1 QA). The
          // strip is exactly its chips' height.
          style={styles.chipStrip}
          testID="icon-picker-chips"
          contentContainerStyle={styles.chips}
          keyboardShouldPersistTaps="handled"
        >
          {chips.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => jump(c.id)}
              accessibilityRole="button"
              accessibilityLabel={`Jump to ${c.title}`}
              style={[styles.chip, { borderColor: tokens.outlineVariant }]}
            >
              <Text style={[styles.chipLabel, { color: tokens.inkVariant }]}>{c.chip}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {!searching && (
        <Text style={[styles.tip, { color: tokens.inkMuted }]}>
          Long-press an icon to star it: favourites come first.
        </Text>
      )}

      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        getItemLayout={(_, index) => ({
          length: rows[index]?.kind === 'header' ? headerH : rowH,
          offset: offsets[index] ?? 0,
          index,
        })}
        initialNumToRender={9}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={
          searching ? (
            <View style={styles.note}>
              <Icon source="information-outline" size={16} color={tokens.inkMuted} />
              <Text style={[styles.noteText, { color: tokens.inkMuted }]}>
                Search matches names and synonyms (spring, source, eau). GPX files from other apps
                keep their own symbol.
              </Text>
            </View>
          ) : null
        }
        testID="icon-picker-list"
      />
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  page: { flex: 1 },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 8,
    paddingRight: 20,
    height: 48,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 8 },
  backLabel: { fontSize: 18, fontWeight: '800' },
  current: { fontSize: 14, flexShrink: 1, marginLeft: 12 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
    height: 48,
    borderRadius: 24,
    paddingLeft: 16,
    paddingRight: 4,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  clear: { margin: 0 },
  chipStrip: { flexGrow: 0, flexShrink: 0 },
  chips: { gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  chip: {
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 13, fontWeight: '600' },
  count: { fontSize: 12, fontWeight: '700', marginHorizontal: 20, marginBottom: 4 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 12, paddingBottom: 24 },
  header: {
    height: HEADER_H,
    paddingTop: 14,
    paddingHorizontal: 8,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center' },
  tip: { fontSize: 12, paddingHorizontal: 20, paddingBottom: 2 },
  note: { flexDirection: 'row', gap: 8, paddingHorizontal: 8, paddingTop: 12 },
  noteText: { flex: 1, fontSize: 12, lineHeight: 16 },
});
