import { filterCatalogItems } from '@core/catalog/filterCatalog';
import { indexInstallStatus } from '@core/catalog/installStatus';
import { catalogItemDistanceMeters } from '@core/catalog/nearest';
import { nearbySections, sortCatalogItemsCanadianFirst } from '@core/catalog/nearbySections';
import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_LABELS,
  type CatalogCategory,
  type CatalogItem,
  type CatalogSource,
} from '@core/catalog/schema';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useRouter } from 'expo-router';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Chip,
  Icon,
  Portal,
  Snackbar,
  Text,
  useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { radius, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { CatalogItemRow } from './CatalogItemRow';
import { CategoryGrid } from './CategoryGrid';
import { DestinationFolderDialog } from './DestinationFolderDialog';
import {
  CatalogDownloadCanceled,
  cancelCatalogDownload,
  downloadCatalogItemToLibrary,
} from './downloadCatalogItem';

/**
 * The Explore tab ("Maps" before 2.0.0) — a free-map store over the world catalog (revamp
 * `After-Maps.html`, spec §6).
 *
 * Lands on **"Near you · Canadian sources first"**: the nearest Canadian
 * sheets, then the nearest US quads "across the border", each nearest-first
 * (`@core/catalog/nearbySections` — plain nearest-first showed only Maine quads
 * from Québec City, where CanTopo has a hole). The category grid follows. With
 * no known position the sections simply aren't there and the grid takes the
 * whole screen — browsing the world still works.
 *
 * The catalog is sharded (`/catalog/v2/`): the screen only ever has the index
 * plus the shards nearest to wherever the user is looking, so opening the tab
 * costs a few kilobytes, not the whole world. `ensureShardsNear` is re-run when
 * the category changes, which is what fills the list on the way into it.
 *
 * Tapping a category (or typing) shows the item list, sorted nearest-first,
 * each row with an offline locator thumbnail. Downloads land in the Library as
 * regular imported maps with live progress; dedup against the Library shows
 * "Open"/"Update" instead of a second Download.
 */

/** Settle time before a query costs a digest lookup and a shard fetch. */
const SEARCH_DEBOUNCE_MS = 300;

/** Module-scope so the list's props don't churn on every render. */
const keyExtractor = (item: CatalogItem) => item.id;

export function StoreScreen() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const status = useCatalogStore((s) => s.status);
  const index = useCatalogStore((s) => s.index);
  const items = useCatalogStore((s) => s.items);
  const loadingShards = useCatalogStore((s) => s.loadingShards);
  const loadingSearch = useCatalogStore((s) => s.loadingSearch);
  const searchScope = useCatalogStore((s) => s.searchScope);
  const pendingQueryShardIds = useCatalogStore((s) => s.pendingQueryShardIds);
  const fromCache = useCatalogStore((s) => s.fromCache);
  const downloads = useCatalogStore((s) => s.downloads);
  const lastFolderId = useCatalogStore((s) => s.lastFolderId);
  const load = useCatalogStore((s) => s.load);
  const ensureShardsNear = useCatalogStore((s) => s.ensureShardsNear);
  const ensureShardsForQuery = useCatalogStore((s) => s.ensureShardsForQuery);
  const searchWholeCatalog = useCatalogStore((s) => s.searchWholeCatalog);

  const maps = useLibraryStore((s) => s.maps);
  const folders = useLibraryStore((s) => s.folders);
  const addFolder = useLibraryStore((s) => s.addFolder);
  const setActiveMap = useLibraryStore((s) => s.setActiveMap);

  const lastKnownPosition = useSettingsStore((s) => s.lastKnownPosition);
  const units = useSettingsStore((s) => s.units);

  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3500);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CatalogCategory | null>(null);
  /** True once the user entered a category (or "All") from the landing grid. */
  const [browsing, setBrowsing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Item awaiting a destination folder in the dialog. */
  const [pendingItem, setPendingItem] = useState<CatalogItem | null>(null);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  // Pull the shards this view needs: nearest across all categories for the
  // landing, nearest within the category once the user is inside one.
  useEffect(() => {
    if (status !== 'ready') return;
    void ensureShardsNear(lastKnownPosition, category);
  }, [status, lastKnownPosition, category, ensureShardsNear]);

  // …and the shards a *query* needs, which geography alone would never reach:
  // the tab is called Search, and before this the query only ever filtered the
  // handful of shards pulled for wherever the user happened to be standing.
  // Debounced so a word costs one digest lookup, not one per keystroke.
  //
  // Deliberately keyed on the LIVE query, not the deferred one below: the
  // 300 ms debounce is already the settle window, and the network round-trip
  // is the long pole — starting it from the deferred copy would only push the
  // fetch a render behind the user for no saved work.
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (status !== 'ready' || trimmedQuery === '') return;
    const timer = setTimeout(() => {
      void ensureShardsForQuery(trimmedQuery, lastKnownPosition);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [status, trimmedQuery, lastKnownPosition, ensureShardsForQuery]);

  // Typing must never wait on the list. Filtering + the nearest-first sort walk
  // every loaded item (and every new row rebuilds a locator thumbnail), so the
  // Searchbar keeps the live `query` while the list re-derives from a deferred
  // copy — React renders the keystroke first and the heavier list pass after,
  // dropping intermediate passes when the user keeps typing.
  const deferredQuery = useDeferredValue(query);
  const deferredTrimmedQuery = deferredQuery.trim();
  const filtered = useMemo(
    () => filterCatalogItems(items, { text: deferredQuery, category }),
    [items, deferredQuery, category],
  );
  const sorted = useMemo(
    () => sortCatalogItemsCanadianFirst(filtered, lastKnownPosition),
    [filtered, lastKnownPosition],
  );
  const sections = useMemo(
    () => nearbySections(items, lastKnownPosition),
    [items, lastKnownPosition],
  );
  const categoryCounts = useMemo(() => index?.categoryCounts ?? {}, [index]);
  const chipCategories = useMemo(
    () => CATALOG_CATEGORIES.filter((c) => (categoryCounts[c] ?? 0) > 0),
    [categoryCounts],
  );
  const sourcesById = useMemo(
    () => new Map<string, CatalogSource>((index?.sources ?? []).map((s) => [s.id, s])),
    [index],
  );
  // Install state for the whole catalog, indexed once per (items, maps) change.
  // Doing it per row meant `installStatusFor` scanned the entire library for
  // every visible cell on every render — O(rows × library) on a screen that
  // re-renders on each download-progress tick.
  const installStatusById = useMemo(() => indexInstallStatus(items, maps), [items, maps]);

  // Landing (Near you + category grid) until the user types or picks one.
  //
  // Deliberately keyed on `deferredQuery`, not `query`: the list below derives
  // from the deferred copy, so switching on the LIVE query flips to the list
  // branch one pass before the list has the new query — rendering everything
  // loaded, unfiltered, for that pass. It converges, but it is a visible flash
  // on the first keystroke, and a very expensive one now the catalog is the
  // whole world. `searching` moves with it for the same reason: the empty
  // state and footer describe the list, so they must describe the query the
  // list is actually showing.
  const home = !browsing && deferredTrimmedQuery === '';
  /** True while a text query is active — the only time search scope matters. */
  const searching = deferredTrimmedQuery !== '';

  const searchWholeCatalogNow = () => void searchWholeCatalog(trimmedQuery, lastKnownPosition);

  const enterCategory = (c: CatalogCategory | null) => {
    setCategory(c);
    setBrowsing(true);
  };

  const leaveList = () => {
    setBrowsing(false);
    setCategory(null);
    setQuery('');
  };

  const startDownload = async (item: CatalogItem, folderId: string | null) => {
    try {
      const doc = await downloadCatalogItemToLibrary(item, folderId);
      const folderName =
        folderId === null
          ? null
          : (useLibraryStore.getState().folders.find((f) => f.id === folderId)?.name ?? null);
      showSnack(
        folderName === null
          ? `"${doc.name}" added to Library`
          : `"${doc.name}" added to Library › ${folderName}`,
      );
    } catch (err) {
      if (err instanceof CatalogDownloadCanceled) return;
      showSnack(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const startUpdate = async (item: CatalogItem) => {
    try {
      const doc = await downloadCatalogItemToLibrary(item, null);
      showSnack(`"${doc.name}" updated`);
    } catch (err) {
      if (err instanceof CatalogDownloadCanceled) return;
      showSnack(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const openInstalled = (item: CatalogItem) => {
    const doc = maps.find((m) => m.sourceItemId === item.id);
    if (doc === undefined) return;
    setActiveMap(doc.id);
    router.navigate('/');
  };

  const renderCard = useCallback(
    (item: CatalogItem, distanceMeters: number | null) => (
      <CatalogItemRow
        key={item.id}
        item={item}
        source={sourcesById.get(item.sourceId)}
        // Read out of the prebuilt index, never re-scanned per row: see
        // `installStatusById` above. An item the index has not seen (it is
        // built from the same `items` these rows come from, so only reachable
        // transiently) reads as not installed, exactly as a fresh scan would.
        installStatus={installStatusById.get(item.id) ?? 'not-installed'}
        downloading={item.id in downloads}
        progress={downloads[item.id]}
        expanded={expandedId === item.id}
        distanceMeters={distanceMeters}
        units={units}
        onToggleExpand={() => setExpandedId(expandedId === item.id ? null : item.id)}
        onDownload={() => setPendingItem(item)}
        onUpdate={() => void startUpdate(item)}
        onOpen={() => openInstalled(item)}
        onCancel={() => cancelCatalogDownload(item.id)}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers close over stable store actions
    [sourcesById, installStatusById, maps, downloads, expandedId, units],
  );

  const renderItem = ({ item }: { item: CatalogItem }) =>
    renderCard(
      item,
      lastKnownPosition !== null ? catalogItemDistanceMeters(item, lastKnownPosition) : null,
    );

  // Stable across renders: a fresh array literal here invalidates the list's
  // content container on every download-progress tick. `keyExtractor` is
  // module-scope for the same reason.
  //
  // `renderCard`'s useCallback above buys nothing on a progress tick — it
  // closes over `downloads` and `expandedId`, which are exactly what changes
  // then — it is there so the landing's "Near you" rows and the list rows
  // stay one code path. Cells therefore still re-render on every tick. Fixing
  // that for real needs the progress subscribed per row inside
  // `CatalogItemRow` — a UI refactor, not a mechanical one, so not done here.
  const listContentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );

  const emptyState = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <View style={styles.emptyWrap}>
          <InukshukLoader />
          <Text variant="bodyMedium" style={styles.emptyText}>
            Loading the map catalog…
          </Text>
        </View>
      );
    }
    if (status === 'error') {
      return (
        <View style={styles.emptyWrap}>
          <Text variant="bodyMedium" style={styles.emptyText}>
            Couldn’t load the map catalog. Check your connection and try again.
          </Text>
          <Button mode="contained-tonal" onPress={() => void load(true)}>
            Retry
          </Button>
        </View>
      );
    }
    if (loadingShards || loadingSearch) {
      return (
        <View style={styles.emptyWrap}>
          <ActivityIndicator />
          <Text variant="bodyMedium" style={styles.emptyText}>
            {searching ? 'Searching the catalog…' : 'Loading maps for this area…'}
          </Text>
        </View>
      );
    }
    if (!searching) {
      return (
        <View style={styles.emptyWrap}>
          <Text variant="bodyMedium" style={styles.emptyText}>
            {home ? 'The catalog is empty right now.' : 'No maps in this area yet.'}
          </Text>
        </View>
      );
    }
    // A query with nothing to show. What we are allowed to say depends on how
    // much of the catalog was actually searched: the store only reports
    // 'complete' once every shard that could match is in.
    if (searchScope === 'complete') {
      return (
        <View style={styles.emptyWrap}>
          <Text variant="bodyMedium" style={styles.emptyText}>
            No maps match your search.
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyWrap}>
        <Text variant="bodyMedium" style={styles.emptyText}>
          {searchScope === 'partial'
            ? `No matches yet — still ${pendingQueryShardIds.length} area${
                pendingQueryShardIds.length === 1 ? '' : 's'
              } of the catalog to search.`
            : 'Searched the maps loaded for this area only — the rest of the catalog needs a connection.'}
        </Text>
        <Button mode="contained-tonal" onPress={searchWholeCatalogNow}>
          Search the whole catalog
        </Button>
      </View>
    );
  };

  /**
   * Below a non-empty list: the spinner while shards land, and — when a query
   * has matches but has not covered the catalog yet — the same explicit
   * "there is more" affordance the empty state offers. Silence here would let
   * a partial result read as the complete one.
   */
  const listFooter = () => {
    if (sorted.length === 0) return null;
    if (loadingShards || loadingSearch) {
      return (
        <View style={styles.footer}>
          <ActivityIndicator size="small" />
        </View>
      );
    }
    if (!searching || searchScope === 'complete') return null;
    return (
      <View style={styles.footer}>
        <Text
          variant="bodySmall"
          style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}
        >
          {searchScope === 'partial'
            ? 'More of the catalog is still to search.'
            : 'Showing matches from this area only.'}
        </Text>
        <Button compact mode="contained-tonal" onPress={searchWholeCatalogNow}>
          Search the whole catalog
        </Button>
      </View>
    );
  };

  const hasUsSection = sections.some((section) => section.country === 'US');

  const landing = () => {
    if (status !== 'ready' || chipCategories.length === 0) return emptyState();
    return (
      <ScrollView
        contentContainerStyle={[styles.landing, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {sections.map((section, sectionIndex) => (
          <View key={section.country} style={styles.section}>
            {sectionIndex === 0 ? (
              <View style={styles.leadHeader}>
                <Text accessibilityRole="header" style={[styles.leadTitle, { color: tokens.ink }]}>
                  {section.title}
                </Text>
                {section.country === 'CA' && (
                  <Text style={[styles.leadSubtitle, { color: tokens.inkMuted }]}>
                    {hasUsSection
                      ? 'Canadian sheets, sorted by distance. The nearest US maps follow.'
                      : 'Canadian sheets, sorted by distance.'}
                  </Text>
                )}
              </View>
            ) : (
              <View style={[styles.subHeader, { borderTopColor: tokens.outlineVariant }]}>
                <Text
                  accessibilityRole="header"
                  style={[styles.subTitle, { color: tokens.inkMuted }]}
                >
                  {section.title.toUpperCase()}
                </Text>
              </View>
            )}
            {section.entries.map((entry, i) => (
              <View key={entry.item.id}>
                {i > 0 && <View style={[styles.divider, { backgroundColor: tokens.divider }]} />}
                {renderCard(entry.item, entry.distanceMeters)}
              </View>
            ))}
          </View>
        ))}
        {hasUsSection && (
          <View
            style={[
              styles.footnote,
              {
                backgroundColor: tokens.elevation.level1,
                borderColor: tokens.outlineVariant,
              },
            ]}
          >
            <Icon source="information-outline" size={20} color={tokens.inkVariant} />
            <Text style={[styles.footnoteText, { color: tokens.inkVariant }]}>
              US Topo covers the United States only.
            </Text>
          </View>
        )}
        {sections.length === 0 && lastKnownPosition === null && (
          <Text style={[styles.hint, { color: tokens.inkMuted }]}>
            Open the Map tab once to see the maps near you first.
          </Text>
        )}
        <View
          style={[styles.subHeader, styles.browseHeader, { borderTopColor: tokens.outlineVariant }]}
        >
          <Text accessibilityRole="header" style={[styles.subTitle, { color: tokens.inkMuted }]}>
            BROWSE BY TYPE
          </Text>
          <Button compact onPress={() => enterCategory(null)}>
            See all
          </Button>
        </View>
        <CategoryGrid
          categories={chipCategories}
          counts={categoryCounts}
          onSelect={enterCategory}
        />
      </ScrollView>
    );
  };

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <Appbar.Header style={{ backgroundColor: theme.colors.background }}>
        {browsing && <Appbar.BackAction onPress={leaveList} />}
        <Appbar.Content
          title={
            browsing && category !== null
              ? CATALOG_CATEGORY_LABELS[category]
              : browsing
                ? 'All maps'
                : 'Explore'
          }
          titleStyle={browsing ? undefined : styles.screenTitle}
        />
      </Appbar.Header>

      <View
        style={[
          styles.search,
          { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
        ]}
      >
        <Icon source="magnify" size={20} color={tokens.inkMuted} />
        <TextInput
          placeholder="Search maps"
          placeholderTextColor={tokens.inkMuted}
          accessibilityLabel="Search maps"
          value={query}
          onChangeText={setQuery}
          // #235 — results are live-filtered; Return just puts the keyboard away.
          returnKeyType="search"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={() => Keyboard.dismiss()}
          autoCorrect={false}
          style={[
            styles.searchInput,
            { color: tokens.ink, fontFamily: theme.fonts.bodyLarge.fontFamily },
          ]}
        />
        {query !== '' && (
          <Pressable
            onPress={() => setQuery('')}
            hitSlop={target.compactHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={styles.clear}
          >
            <Icon source="close" size={20} color={tokens.inkMuted} />
          </Pressable>
        )}
      </View>

      {fromCache && status === 'ready' && (
        <Text
          variant="bodySmall"
          style={[styles.cacheNote, { color: theme.colors.onSurfaceVariant }]}
        >
          Showing the saved catalog — downloads need a connection.
        </Text>
      )}

      {home ? (
        landing()
      ) : (
        <>
          {chipCategories.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.chipRow}
              contentContainerStyle={styles.chipRowContent}
            >
              <Chip
                selected={category === null}
                onPress={() => setCategory(null)}
                style={styles.chip}
                compact
              >
                All
              </Chip>
              {chipCategories.map((c) => (
                <Chip
                  key={c}
                  selected={category === c}
                  onPress={() => setCategory(category === c ? null : c)}
                  style={styles.chip}
                  compact
                >
                  {CATALOG_CATEGORY_LABELS[c]}
                </Chip>
              ))}
            </ScrollView>
          )}

          <FlatList
            data={sorted}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            ListEmptyComponent={emptyState()}
            ListFooterComponent={listFooter()}
            // Reaching the end of what is loaded pulls the next-nearest shards,
            // so the grid's "65 877 maps" is something the user can actually
            // scroll into rather than a number with 400 rows behind it.
            onEndReached={() => {
              if (loadingShards) return;
              if (searching) return;
              void ensureShardsNear(lastKnownPosition, category);
            }}
            onEndReachedThreshold={0.6}
            contentContainerStyle={listContentStyle}
            ItemSeparatorComponent={RowDivider}
            keyboardShouldPersistTaps="handled"
            // Each row builds an SVG locator thumbnail, so the defaults
            // (initialNumToRender 10, windowSize 21) do far more work up front
            // and retain far more mounted rows than this list needs.
            // No removeClippedSubviews: on Android it is a known cause of
            // blank cells and dropped touches, these rows render react-native-
            // svg trees, and nothing else in this app uses it. The window
            // tuning above stands on its own.
            //
            // It does interact with `onEndReached`: a short initial window can
            // put the end of the rendered content inside the threshold on
            // mount, so the next ring of shards may be pulled straight away.
            // That is the same work the first scroll would have done, and
            // `ensureShardsNear` is bounded per call and skips what is loaded
            // or in flight, so it costs one earlier batch, never a loop.
            initialNumToRender={6}
            maxToRenderPerBatch={5}
            windowSize={7}
          />
        </>
      )}

      <Portal>
        <DestinationFolderDialog
          key={pendingItem?.id ?? 'closed'}
          visible={pendingItem !== null}
          itemTitle={pendingItem?.title ?? ''}
          {...(pendingItem?.sizeBytes !== undefined ? { sizeBytes: pendingItem.sizeBytes } : {})}
          folders={folders}
          initialFolderId={lastFolderId}
          onCreateFolder={addFolder}
          onDismiss={() => setPendingItem(null)}
          onConfirm={(folderId) => {
            const item = pendingItem;
            setPendingItem(null);
            if (item !== null) void startDownload(item, folderId);
          }}
        />
      </Portal>

      <Snackbar visible={snack !== null} onDismiss={dismissSnack} duration={Infinity}>
        {snack ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screenTitle: { fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.3 },
  search: {
    marginHorizontal: space.lg,
    marginTop: 2,
    marginBottom: space.lg,
    height: target.min,
    borderRadius: target.min / 2,
    borderWidth: 1,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: { flex: 1, minWidth: 0, height: 44, padding: 0, fontSize: 16 },
  clear: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  chipRow: { flexGrow: 0 },
  chipRowContent: { paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.sm },
  chip: { marginRight: 0 },
  cacheNote: { paddingHorizontal: space.lg, paddingBottom: 6 },
  landing: { paddingTop: 0 },
  section: { paddingBottom: space.xs },
  leadHeader: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.xs },
  leadTitle: { fontSize: 18, lineHeight: 24, fontWeight: '800' },
  leadSubtitle: { fontSize: 13, lineHeight: 18 },
  subHeader: {
    marginTop: space.xs,
    paddingTop: 14,
    paddingHorizontal: space.lg,
    paddingBottom: 6,
    borderTopWidth: 1,
  },
  browseHeader: {
    marginTop: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: space.sm,
  },
  subTitle: { fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: 0.8 },
  divider: { height: 1, marginLeft: 84 },
  footnote: {
    marginTop: space.sm,
    marginHorizontal: space.lg,
    paddingVertical: space.md,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  footnoteText: { flex: 1, fontSize: 13, lineHeight: 18 },
  hint: { paddingHorizontal: space.lg, paddingBottom: 10, fontSize: 13, lineHeight: 18 },
  listContent: {},
  footer: { paddingVertical: 16, alignItems: 'center' },
  emptyWrap: { alignItems: 'center', gap: 12, paddingTop: 64, paddingHorizontal: 24 },
  emptyText: { textAlign: 'center' },
});

/** Hairline between list rows, inset past the thumbnail (board: 84 dp). */
function RowDivider() {
  const tokens = useSchemeTokens();
  return <View style={[styles.divider, { backgroundColor: tokens.divider }]} />;
}
