import { indexInstallStatus } from '@core/catalog/installStatus';
import { catalogItemDistanceMeters } from '@core/catalog/nearest';
import type { CatalogItem, CatalogSource } from '@core/catalog/schema';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, type ReactElement } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatalogItemRow } from '../CatalogItemRow';
import { exploreItemHref } from './exploreRoutes';
import type { CatalogDownloadFlow } from './useCatalogDownloadFlow';

/** Module-scope so the list's props don't churn on every render. */
const keyExtractor = (item: CatalogItem) => item.id;

/**
 * The explorer's result list (landing search, filtered lists): the store's
 * existing {@link CatalogItemRow}, nearest-first as given, each row opening the
 * map's detail screen and carrying the one action its install state calls for.
 *
 * Install state is indexed once per (items, maps) change, never re-scanned
 * per row, and the FlatList window is tuned for rows that each draw an SVG
 * locator (see the notes this replaced in StoreScreen).
 */
export function CatalogResultsList({
  data,
  flow,
  ListEmptyComponent,
  ListFooterComponent,
  onEndReached,
}: {
  data: readonly CatalogItem[];
  flow: CatalogDownloadFlow;
  ListEmptyComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
  onEndReached?: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const index = useCatalogStore((s) => s.index);
  const items = useCatalogStore((s) => s.items);
  const downloads = useCatalogStore((s) => s.downloads);
  const maps = useLibraryStore((s) => s.maps);
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const units = useSettingsStore((s) => s.units);

  const sourcesById = useMemo(
    () => new Map<string, CatalogSource>((index?.sources ?? []).map((s) => [s.id, s])),
    [index],
  );
  const installStatusById = useMemo(() => indexInstallStatus(items, maps), [items, maps]);

  const { requestDownload, update, open, cancel } = flow;
  const renderItem = useCallback(
    ({ item }: { item: CatalogItem }) => (
      <CatalogItemRow
        item={item}
        source={sourcesById.get(item.sourceId)}
        installStatus={installStatusById.get(item.id) ?? 'not-installed'}
        downloading={item.id in downloads}
        progress={downloads[item.id]}
        expanded={false}
        distanceMeters={position !== null ? catalogItemDistanceMeters(item, position) : null}
        units={units}
        onToggleExpand={() => undefined}
        onOpenDetails={() => router.push(exploreItemHref(item.id))}
        onDownload={() => requestDownload(item)}
        onUpdate={() => update(item)}
        onOpen={() => open(item)}
        onCancel={() => cancel(item)}
      />
    ),
    [
      sourcesById,
      installStatusById,
      downloads,
      position,
      units,
      router,
      requestDownload,
      update,
      open,
      cancel,
    ],
  );

  const contentStyle = useMemo(() => ({ paddingBottom: insets.bottom + 24 }), [insets.bottom]);

  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListEmptyComponent={ListEmptyComponent}
      ListFooterComponent={ListFooterComponent}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      contentContainerStyle={contentStyle}
      ItemSeparatorComponent={RowDivider}
      keyboardShouldPersistTaps="handled"
      // Each row draws an SVG locator: a short window, no removeClippedSubviews
      // (a known cause of blank cells on Android with svg rows).
      initialNumToRender={6}
      maxToRenderPerBatch={5}
      windowSize={7}
    />
  );
}

/** Hairline between rows, inset past the thumbnail (board: 84 dp). */
function RowDivider() {
  const tokens = useSchemeTokens();
  return <View style={[styles.divider, { backgroundColor: tokens.divider }]} />;
}

const styles = StyleSheet.create({
  divider: { height: 1, marginLeft: 84 },
});
