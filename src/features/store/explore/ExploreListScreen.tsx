import {
  categoryForKind,
  filterExploreItems,
  type ExploreFilter,
} from '@core/catalog/exploreFacets';
import { sortCatalogItemsCanadianFirst } from '@core/catalog/nearbySections';
import type { CatalogSource } from '@core/catalog/schema';
import {
  CATALOG_ACTIVITY_LABELS,
  CATALOG_KIND_LABELS,
  CATALOG_TERRAIN_LABELS,
} from '@core/catalog/taxonomy';
import { useCatalogStore } from '@state/catalogStore';
import { useSettingsStore } from '@state/settingsStore';
import { HeaderContours } from '@ui/components/ContourTexture';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { HeaderAction, ScreenHeader } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatalogResultsList } from './CatalogResultsList';
import { ExploreFilterBar } from './ExploreFilterBar';
import { exploreMapHref } from './exploreRoutes';
import { itemFacets } from './facetsAdapter';
import { useCatalogDownloadFlow } from './useCatalogDownloadFlow';

/**
 * A filtered explorer list (#447): what tapping an activity, a terrain, a
 * publisher or a type on the landing opens. ScreenHeader with the back arrow,
 * the filter chips, then the matching loaded maps nearest-first (Canadian
 * sources first, as everywhere in the store) with the store's own rows, and a
 * toggle to the same filter on a map.
 *
 * Works from the loaded shards only: it pulls the nearest ones on the way in
 * (just the right category's when the type implies one) and the next ring when
 * the user scrolls to the end, so a list never costs the whole catalog.
 */

/** The header title for a filter: the most specific facet set. */
export function exploreFilterTitle(
  filter: ExploreFilter,
  sources: readonly CatalogSource[],
): string {
  if (filter.sourceId != null) {
    return sources.find((s) => s.id === filter.sourceId)?.name ?? 'Maps';
  }
  if (filter.activity != null) return CATALOG_ACTIVITY_LABELS[filter.activity];
  if (filter.terrain != null) return CATALOG_TERRAIN_LABELS[filter.terrain];
  if (filter.kind != null) return CATALOG_KIND_LABELS[filter.kind];
  return 'All maps';
}

export function ExploreListScreen({ initialFilter }: { initialFilter: ExploreFilter }) {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const flow = useCatalogDownloadFlow();

  const status = useCatalogStore((s) => s.status);
  const index = useCatalogStore((s) => s.index);
  const items = useCatalogStore((s) => s.items);
  const loadingShards = useCatalogStore((s) => s.loadingShards);
  const fromCache = useCatalogStore((s) => s.fromCache);
  const load = useCatalogStore((s) => s.load);
  const ensureShardsNear = useCatalogStore((s) => s.ensureShardsNear);
  const unavailableShardIds = useCatalogStore((s) => s.unavailableShardIds);
  const position = useSettingsStore((s) => s.lastKnownPosition);

  const [filter, setFilter] = useState<ExploreFilter>(initialFilter);
  const category = categoryForKind(filter.kind);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  useEffect(() => {
    if (status !== 'ready') return;
    void ensureShardsNear(position, category);
  }, [status, position, category, ensureShardsNear]);

  const sources = useMemo(() => index?.sources ?? [], [index]);
  const filtered = useMemo(() => filterExploreItems(items, filter, itemFacets), [items, filter]);
  const sorted = useMemo(
    () => sortCatalogItemsCanadianFirst(filtered, position),
    [filtered, position],
  );

  // More of the catalog left to pull? (Everything not loaded, in flight or
  // cooling down after a failure.) Recomputed per render: cheap, and it
  // tracks `loadingShards`/`items` changes without its own subscription.
  const moreToLoad =
    index !== null && unavailableShardIds().size < index.shards.length && !loadingShards;
  const loadMore = () => {
    if (status === 'ready' && !loadingShards) void ensureShardsNear(position, category);
  };

  const title = exploreFilterTitle(filter, sources);

  const empty = () => {
    if (status === 'idle' || status === 'loading') {
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
    if (loadingShards) {
      return (
        <View style={styles.emptyWrap}>
          <ActivityIndicator />
          <Text variant="bodyMedium" style={styles.emptyText}>
            Loading maps for this area…
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyWrap}>
        <Text variant="bodyMedium" style={[styles.emptyText, { color: t.inkVariant }]}>
          No maps like this in the areas loaded so far.
        </Text>
        {moreToLoad && (
          <Button mode="contained-tonal" onPress={loadMore}>
            Look further away
          </Button>
        )}
      </View>
    );
  };

  const footer =
    sorted.length > 0 && loadingShards ? (
      <View style={styles.footer}>
        <ActivityIndicator size="small" />
      </View>
    ) : null;

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <HeaderContours />
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title={title} onBack={() => router.back()}>
          <HeaderAction
            icon="map-outline"
            onPress={() => router.replace(exploreMapHref(filter))}
            accessibilityLabel="Show on a map"
          />
        </ScreenHeader>
      </View>
      {fromCache && status === 'ready' && (
        <Text variant="bodySmall" style={[styles.cacheNote, { color: t.inkMuted }]}>
          Showing the saved catalog — downloads need a connection.
        </Text>
      )}
      <ExploreFilterBar filter={filter} onChange={setFilter} items={items} sources={sources} />
      <CatalogResultsList
        data={sorted}
        flow={flow}
        ListEmptyComponent={empty()}
        ListFooterComponent={footer}
        onEndReached={loadMore}
      />
      {flow.overlays}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cacheNote: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  footer: { paddingVertical: 16, alignItems: 'center' },
  emptyWrap: { alignItems: 'center', gap: 12, paddingTop: 48, paddingHorizontal: 24 },
  emptyText: { textAlign: 'center' },
});
