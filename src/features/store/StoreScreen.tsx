import { filterCatalogItems } from '@core/catalog/filterCatalog';
import { installStatusFor } from '@core/catalog/installStatus';
import { nearbyCatalogItems } from '@core/catalog/nearby';
import { catalogItemDistanceMeters, sortCatalogItems } from '@core/catalog/nearest';
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Chip,
  Portal,
  Searchbar,
  Snackbar,
  Text,
  useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { CatalogItemCard } from './CatalogItemCard';
import { CategoryGrid } from './CategoryGrid';
import { DestinationFolderDialog } from './DestinationFolderDialog';
import {
  CatalogDownloadCanceled,
  cancelCatalogDownload,
  downloadCatalogItemToLibrary,
} from './downloadCatalogItem';

/**
 * The Search tab — a free-map store over the world catalog.
 *
 * Lands on **"Around you"** (the nearest few items across every category, from
 * the last known position) above the category grid, so a user standing on a
 * shoreline sees the chart of that shoreline before anything else. With no
 * known position the section simply isn't there and the grid takes the whole
 * screen — browsing the world still works.
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

/** How many rows the landing's "Around you" section shows. */
const NEARBY_ROWS = 5;

/** Settle time before a query costs a digest lookup and a shard fetch. */
const SEARCH_DEBOUNCE_MS = 300;

export function StoreScreen() {
  const theme = useTheme();
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
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (status !== 'ready' || trimmedQuery === '') return;
    const timer = setTimeout(() => {
      void ensureShardsForQuery(trimmedQuery, lastKnownPosition);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [status, trimmedQuery, lastKnownPosition, ensureShardsForQuery]);

  const filtered = useMemo(
    () => filterCatalogItems(items, { text: query, category }),
    [items, query, category],
  );
  const sorted = useMemo(
    () => sortCatalogItems(filtered, lastKnownPosition),
    [filtered, lastKnownPosition],
  );
  const nearby = useMemo(
    () => nearbyCatalogItems(items, lastKnownPosition, { limit: NEARBY_ROWS }),
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

  // Landing (Around you + category grid) until the user types or picks one.
  const home = !browsing && trimmedQuery === '';
  /** True while a text query is active — the only time search scope matters. */
  const searching = trimmedQuery !== '';

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
      <CatalogItemCard
        key={item.id}
        item={item}
        source={sourcesById.get(item.sourceId)}
        installStatus={installStatusFor(item, maps)}
        downloading={item.id in downloads}
        progress={downloads[item.id]}
        expanded={expandedId === item.id}
        distanceMeters={distanceMeters}
        onToggleExpand={() => setExpandedId(expandedId === item.id ? null : item.id)}
        onDownload={() => setPendingItem(item)}
        onUpdate={() => void startUpdate(item)}
        onOpen={() => openInstalled(item)}
        onCancel={() => cancelCatalogDownload(item.id)}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers close over stable store actions
    [sourcesById, maps, downloads, expandedId],
  );

  const renderItem = ({ item }: { item: CatalogItem }) =>
    renderCard(
      item,
      lastKnownPosition !== null ? catalogItemDistanceMeters(item, lastKnownPosition) : null,
    );

  const emptyState = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <View style={styles.emptyWrap}>
          <ActivityIndicator />
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
        <Text variant="bodySmall" style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
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

  const landing = () => {
    if (status !== 'ready' || chipCategories.length === 0) return emptyState();
    return (
      <ScrollView
        contentContainerStyle={[styles.landing, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {nearby.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text variant="titleMedium">Around you</Text>
              <Button compact onPress={() => enterCategory(null)}>
                See all
              </Button>
            </View>
            <View style={styles.sectionRows}>
              {nearby.map((entry) => renderCard(entry.item, entry.distanceMeters))}
            </View>
          </View>
        )}
        {nearby.length === 0 && lastKnownPosition === null && (
          <Text variant="bodySmall" style={[styles.hint, { color: theme.colors.onSurfaceVariant }]}>
            Open the Map tab once to let “Around you” show what’s near.
          </Text>
        )}
        <CategoryGrid
          categories={chipCategories}
          counts={categoryCounts}
          onSelect={enterCategory}
        />
      </ScrollView>
    );
  };

  return (
    <View style={styles.fill}>
      <Appbar.Header>
        {browsing && <Appbar.BackAction onPress={leaveList} />}
        <Appbar.Content
          title={
            browsing && category !== null
              ? CATALOG_CATEGORY_LABELS[category]
              : browsing
                ? 'All maps'
                : 'Search'
          }
        />
      </Appbar.Header>

      <Searchbar
        placeholder="Search maps"
        value={query}
        onChangeText={setQuery}
        style={styles.searchbar}
      />

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
            keyExtractor={(item) => item.id}
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
            contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled"
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
  searchbar: { marginHorizontal: 12, marginBottom: 8 },
  chipRow: { flexGrow: 0 },
  chipRowContent: { paddingHorizontal: 12, gap: 8, paddingBottom: 8 },
  chip: { marginRight: 0 },
  cacheNote: { paddingHorizontal: 16, paddingBottom: 6 },
  landing: { paddingTop: 2 },
  section: { paddingBottom: 12 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 8,
    paddingBottom: 4,
  },
  sectionRows: { paddingHorizontal: 12, gap: 8 },
  hint: { paddingHorizontal: 16, paddingBottom: 10 },
  listContent: { paddingHorizontal: 12, gap: 8 },
  footer: { paddingVertical: 16, alignItems: 'center' },
  emptyWrap: { alignItems: 'center', gap: 12, paddingTop: 64, paddingHorizontal: 24 },
  emptyText: { textAlign: 'center' },
});
