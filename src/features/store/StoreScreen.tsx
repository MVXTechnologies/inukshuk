import {
  categoriesPresent,
  filterCatalogItems,
} from '@core/catalog/filterCatalog';
import { installStatusFor, type InstallStatus } from '@core/catalog/installStatus';
import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_LABELS,
  type CatalogCategory,
  type CatalogItem,
  type CatalogSource,
} from '@core/catalog/schema';
import { formatByteSize } from '@core/storage/diskBudget';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Linking, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Card,
  Chip,
  IconButton,
  Portal,
  ProgressBar,
  Searchbar,
  Snackbar,
  Text,
  useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { DestinationFolderDialog } from './DestinationFolderDialog';
import {
  CatalogDownloadCanceled,
  cancelCatalogDownload,
  downloadCatalogItemToLibrary,
} from './downloadCatalogItem';

/**
 * The Search tab — a free-map store (M1: NRCan CanTopo GeoPDFs). Browses the
 * static catalog manifest (cached on device, see `@data/catalogCache`),
 * filters by diacritic-folded text + category chips, and downloads items into
 * the Library as regular imported maps with live progress. Dedup against the
 * Library shows "Open"/"Update" instead of a second Download.
 */
export function StoreScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const status = useCatalogStore((s) => s.status);
  const manifest = useCatalogStore((s) => s.manifest);
  const fromCache = useCatalogStore((s) => s.fromCache);
  const downloads = useCatalogStore((s) => s.downloads);
  const lastFolderId = useCatalogStore((s) => s.lastFolderId);
  const load = useCatalogStore((s) => s.load);

  const maps = useLibraryStore((s) => s.maps);
  const folders = useLibraryStore((s) => s.folders);
  const addFolder = useLibraryStore((s) => s.addFolder);
  const setActiveMap = useLibraryStore((s) => s.setActiveMap);

  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3500);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CatalogCategory | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Item awaiting a destination folder in the dialog. */
  const [pendingItem, setPendingItem] = useState<CatalogItem | null>(null);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  const items = useMemo(() => manifest?.items ?? [], [manifest]);
  const filtered = useMemo(
    () => filterCatalogItems(items, { text: query, category }),
    [items, query, category],
  );
  const chipCategories = useMemo(() => categoriesPresent(items, CATALOG_CATEGORIES), [items]);
  const sourcesById = useMemo(
    () => new Map<string, CatalogSource>((manifest?.sources ?? []).map((s) => [s.id, s])),
    [manifest],
  );

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

  const metaLine = (item: CatalogItem): string => {
    const parts = [
      sourcesById.get(item.sourceId)?.name,
      item.sizeBytes !== undefined ? formatByteSize(item.sizeBytes) : undefined,
      item.updatedAt,
      item.lang?.toUpperCase(),
    ];
    return parts.filter((p): p is string => p !== undefined).join(' · ');
  };

  const renderActions = (item: CatalogItem, installStatus: InstallStatus, downloading: boolean) => {
    if (downloading) {
      return (
        <IconButton
          icon="close-circle-outline"
          accessibilityLabel={`Cancel download of ${item.title}`}
          onPress={() => cancelCatalogDownload(item.id)}
        />
      );
    }
    if (installStatus === 'installed') {
      return (
        <Button compact onPress={() => openInstalled(item)}>
          Open
        </Button>
      );
    }
    if (installStatus === 'update-available') {
      return (
        <Button compact mode="contained-tonal" onPress={() => void startUpdate(item)}>
          Update
        </Button>
      );
    }
    return (
      <Button compact mode="contained-tonal" onPress={() => setPendingItem(item)}>
        Download
      </Button>
    );
  };

  const renderItem = ({ item }: { item: CatalogItem }) => {
    const source = sourcesById.get(item.sourceId);
    const installStatus = installStatusFor(item, maps);
    const fraction = downloads[item.id];
    const downloading = item.id in downloads;
    const expanded = expandedId === item.id;
    return (
      <Card
        mode="outlined"
        style={styles.card}
        onPress={() => setExpandedId(expanded ? null : item.id)}
      >
        <Card.Content>
          <View style={styles.cardRow}>
            <View style={styles.cardText}>
              <Text variant="titleSmall">{item.title}</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {metaLine(item)}
              </Text>
            </View>
            {renderActions(item, installStatus, downloading)}
          </View>
          {downloading && (
            <ProgressBar
              style={styles.progress}
              progress={fraction ?? 0}
              indeterminate={fraction === null || fraction === undefined}
            />
          )}
          {expanded && (
            <View style={styles.details}>
              {source !== undefined && (
                <Text variant="bodySmall">
                  {source.attribution} — {source.licence}
                </Text>
              )}
              {item.region !== undefined && <Text variant="bodySmall">Region: {item.region}</Text>}
              {item.bbox !== undefined && (
                <Text variant="bodySmall">
                  Coverage: {item.bbox[1].toFixed(2)}°–{item.bbox[3].toFixed(2)}°N,{' '}
                  {Math.abs(item.bbox[2]).toFixed(2)}°–{Math.abs(item.bbox[0]).toFixed(2)}°W
                </Text>
              )}
              {source?.homepage !== undefined && (
                <Button
                  compact
                  icon="open-in-new"
                  style={styles.sourceLink}
                  onPress={() => void Linking.openURL(source.homepage ?? '')}
                >
                  About this source
                </Button>
              )}
            </View>
          )}
        </Card.Content>
      </Card>
    );
  };

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
    return (
      <View style={styles.emptyWrap}>
        <Text variant="bodyMedium" style={styles.emptyText}>
          No maps match your search.
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.fill}>
      <Appbar.Header>
        <Appbar.Content title="Search" />
      </Appbar.Header>

      <Searchbar
        placeholder="Search maps"
        value={query}
        onChangeText={setQuery}
        style={styles.searchbar}
      />

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

      {fromCache && status === 'ready' && (
        <Text
          variant="bodySmall"
          style={[styles.cacheNote, { color: theme.colors.onSurfaceVariant }]}
        >
          Showing the saved catalog — downloads need a connection.
        </Text>
      )}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListEmptyComponent={emptyState()}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      />

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
  listContent: { paddingHorizontal: 12, gap: 8 },
  card: { marginBottom: 0 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardText: { flex: 1 },
  progress: { marginTop: 8, height: 5, borderRadius: 3 },
  details: { marginTop: 10, gap: 3 },
  sourceLink: { alignSelf: 'flex-start', marginTop: 4 },
  emptyWrap: { alignItems: 'center', gap: 12, paddingTop: 64, paddingHorizontal: 24 },
  emptyText: { textAlign: 'center' },
});
