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
import { useExploreHandoffStore } from '@state/exploreHandoffStore';
import { useSettingsStore } from '@state/settingsStore';
import { HeaderContours } from '@ui/components/ContourTexture';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { HeaderAction, ScreenHeader } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatalogResultsList } from './CatalogResultsList';
import { ExploreFilterBar } from './ExploreFilterBar';
import { BrowseOnMapButton } from './ExploreParts';
import { exploreMapHref } from './exploreRoutes';
import { itemFacets } from './facetsAdapter';
import { OrganisationMapsCta } from './OrganisationMapsCta';
import { useCatalogDownloadFlow } from './useCatalogDownloadFlow';

/**
 * A filtered explorer list (#447): what tapping an activity, a terrain, a
 * publisher or a type on the landing opens. ScreenHeader with the back arrow,
 * the filter chips, then the matching loaded maps nearest-first (Canadian
 * sources first, as everywhere in the store) with the store's own rows, and a
 * floating "Browse on the map" pill (plus the header glyph) that pushes the
 * same filter on a map — whose back arrow returns here with its filter.
 *
 * Works from the loaded shards only: it pulls the nearest ones on the way in
 * (just the right category's when the type implies one, and only those the
 * facet digest says hold the activity/terrain/kind) and the next ring when
 * the user scrolls to the end of a non-empty list or taps "Look further
 * away", so a list never costs the whole catalog.
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
  // Subscribed (value unused) so "Look further away" re-evaluates once the
  // facet digest lands.
  useCatalogStore((s) => s.facets);
  const fromCache = useCatalogStore((s) => s.fromCache);
  const load = useCatalogStore((s) => s.load);
  const ensureShardsForFacets = useCatalogStore((s) => s.ensureShardsForFacets);
  const remainingShardCount = useCatalogStore((s) => s.remainingShardCount);
  const position = useSettingsStore((s) => s.lastKnownPosition);

  const [filter, setFilter] = useState<ExploreFilter>(initialFilter);
  const category = categoryForKind(filter.kind);

  // A filter changed on the map this list opened hands itself back (#474).
  // Whatever sits in the slot on arrival belongs to some earlier map.
  useEffect(() => {
    useExploreHandoffStore.getState().clear();
    return useExploreHandoffStore.subscribe(({ listFilter }) => {
      if (listFilter === null) return;
      setFilter(listFilter);
      useExploreHandoffStore.getState().clear();
    });
  }, []);

  // The shard pick only cares about the facets (not publisher or text): keep
  // its identity stable across unrelated filter changes.
  const { kind = null, activity = null, terrain = null } = filter;
  const facetFilter = useMemo(() => ({ kind, activity, terrain }), [kind, activity, terrain]);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  // Pull the first ring for this filter — once per filter, not per GPS fix:
  // the persisted position moves every minute on a run, and re-running this
  // on each move reloaded (and re-flashed the spinner) for nothing. A first
  // fix after none still counts, so "near you" becomes near you.
  const loadNear = useEffectEvent(() => {
    void ensureShardsForFacets(position, facetFilter, category);
  });
  const hasPosition = position !== null;
  useEffect(() => {
    if (status === 'ready') loadNear();
  }, [status, facetFilter, category, hasPosition]);

  const sources = useMemo(() => index?.sources ?? [], [index]);
  const filtered = useMemo(() => filterExploreItems(items, filter, itemFacets), [items, filter]);
  const sorted = useMemo(
    () => sortCatalogItemsCanadianFirst(filtered, position),
    [filtered, position],
  );

  // More of the catalog worth pulling for this filter? (Shards not loaded, in
  // flight or cooling down — and, once the facet digest is in, only those
  // holding such maps.) Recomputed per render: cheap, and it tracks
  // `loadingShards`/`items`/`facets` without a subscription of its own.
  const moreToLoad =
    index !== null && !loadingShards && remainingShardCount(facetFilter, category) > 0;
  const loadMore = () => {
    if (status === 'ready' && !loadingShards) {
      void ensureShardsForFacets(position, facetFilter, category);
    }
  };
  const openMap = () => router.push(exploreMapHref(filter, 'list'));

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
        <OrganisationMapsCta style={styles.ctaEmpty} />
      </View>
    );
  };

  const footer =
    sorted.length === 0 ? null : loadingShards ? (
      <View style={styles.footer}>
        <ActivityIndicator size="small" />
      </View>
    ) : (
      <OrganisationMapsCta style={styles.cta} />
    );

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <HeaderContours />
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title={title} onBack={() => router.back()}>
          <HeaderAction icon="map-outline" onPress={openMap} accessibilityLabel="Show on a map" />
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
        // Page only a list that HAS rows. VirtualizedList also calls
        // onEndReached on an empty list each time the empty view changes
        // height (spinner ↔ message), which looped ring after ring through
        // the whole world catalog (#474); the empty state has its own
        // explicit "Look further away".
        onEndReached={sorted.length > 0 ? loadMore : undefined}
        bottomInset={FLOATING_CLEARANCE}
      />
      <View
        style={[styles.floating, { bottom: insets.bottom + space.lg }]}
        pointerEvents="box-none"
      >
        <BrowseOnMapButton
          floating
          onPress={openMap}
          accessibilityLabel={`Browse ${title === 'All maps' ? 'all maps' : title} on the map`}
        />
      </View>
      {flow.overlays}
    </View>
  );
}

/** Room under the last row so the floating map pill never hides it. */
const FLOATING_CLEARANCE = 72;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  floating: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  cacheNote: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  footer: { paddingVertical: 16, alignItems: 'center' },
  emptyWrap: { alignItems: 'center', gap: 12, paddingTop: 48, paddingHorizontal: 24 },
  emptyText: { textAlign: 'center' },
  cta: { marginHorizontal: space.lg, marginTop: space.lg },
  ctaEmpty: { alignSelf: 'stretch', marginTop: space.md },
});
