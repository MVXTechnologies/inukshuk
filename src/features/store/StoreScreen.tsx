import { HeaderContours } from '@ui/components/ContourTexture';
import { filterCatalogItems } from '@core/catalog/filterCatalog';
import { sortCatalogItemsCanadianFirst } from '@core/catalog/nearbySections';
import { useCatalogStore } from '@state/catalogStore';
import { useSettingsStore } from '@state/settingsStore';
import { useRouter } from 'expo-router';
import { useDeferredValue, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { ActivityIndicator, Button, Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { CatalogResultsList } from './explore/CatalogResultsList';
import { ExploreLanding } from './explore/ExploreLanding';
import { BrowseOnMapButton } from './explore/ExploreParts';
import { exploreMapHref } from './explore/exploreRoutes';
import { OrganisationMapsCta } from './explore/OrganisationMapsCta';
import { useCatalogDownloadFlow } from './explore/useCatalogDownloadFlow';

/**
 * The Explore tab ("Maps" before 2.0.0) — the map explorer (#447, board
 * `Main.dc.html`): an Avenza-style Discover landing over the free world
 * catalog, one search field for places and keywords, and a map toggle.
 *
 * The landing (`./explore/ExploreLanding`) shows Popular near you, By
 * activity, By terrain, Collections and By type; each opens a stack screen
 * under `app/explore/` (filtered list, map, detail, link-out collection).
 * Typing replaces the landing with the result list, backed by the same
 * whole-catalog search as before: the search digest names the shards that
 * could match anywhere in the world, and the empty state only claims "no
 * maps match" once every such shard is in.
 *
 * The catalog is sharded (`/catalog/v2/`): the screen only ever has the index
 * plus the shards nearest to the user (and any a query pulled), so opening the
 * tab costs a few kilobytes, not the whole world. Downloads land in the
 * Library with live progress; installed maps offer Open/Update instead.
 */

/** Settle time before a query costs a digest lookup and a shard fetch. */
const SEARCH_DEBOUNCE_MS = 300;

export function StoreScreen() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const flow = useCatalogDownloadFlow();

  const status = useCatalogStore((s) => s.status);
  const index = useCatalogStore((s) => s.index);
  const items = useCatalogStore((s) => s.items);
  const loadingShards = useCatalogStore((s) => s.loadingShards);
  const loadingSearch = useCatalogStore((s) => s.loadingSearch);
  const searchScope = useCatalogStore((s) => s.searchScope);
  const pendingQueryShardIds = useCatalogStore((s) => s.pendingQueryShardIds);
  const fromCache = useCatalogStore((s) => s.fromCache);
  const load = useCatalogStore((s) => s.load);
  const ensureShardsNear = useCatalogStore((s) => s.ensureShardsNear);
  const ensureShardsForQuery = useCatalogStore((s) => s.ensureShardsForQuery);
  const searchWholeCatalog = useCatalogStore((s) => s.searchWholeCatalog);

  const lastKnownPosition = useSettingsStore((s) => s.lastKnownPosition);

  const [query, setQuery] = useState('');

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  // The landing's "Popular near you" and facet presence come from the shards
  // nearest the user, across all categories. Keyed on a ~10 km cell, not the
  // raw fix: the persisted position moves every minute on a run, and each
  // move pulled another ring and flashed every explorer list's spinner (#474).
  const nearCell =
    lastKnownPosition === null
      ? null
      : `${Math.round(lastKnownPosition.latitude * 10)}:${Math.round(lastKnownPosition.longitude * 10)}`;
  const loadNear = useEffectEvent(() => {
    void ensureShardsNear(lastKnownPosition, null);
  });
  useEffect(() => {
    if (status === 'ready') loadNear();
  }, [status, nearCell]);

  // …and the shards a *query* needs, which geography alone would never reach
  // (a user in Montréal searching "Grand Canyon"). Debounced so a word costs
  // one digest lookup, not one per keystroke; keyed on the LIVE query because
  // the debounce is already the settle window.
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (status !== 'ready' || trimmedQuery === '') return;
    const timer = setTimeout(() => {
      void ensureShardsForQuery(trimmedQuery, lastKnownPosition);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [status, trimmedQuery, lastKnownPosition, ensureShardsForQuery]);

  // Typing must never wait on the list: the field keeps the live query while
  // the list re-derives from a deferred copy. The landing/list switch keys on
  // the deferred copy too, so the list never flashes unfiltered for a pass.
  const deferredQuery = useDeferredValue(query);
  const searching = deferredQuery.trim() !== '';
  const filtered = useMemo(
    () => (searching ? filterCatalogItems(items, { text: deferredQuery }) : []),
    [items, deferredQuery, searching],
  );
  const sorted = useMemo(
    () => sortCatalogItemsCanadianFirst(filtered, lastKnownPosition),
    [filtered, lastKnownPosition],
  );

  const searchWholeCatalogNow = () => void searchWholeCatalog(trimmedQuery, lastKnownPosition);

  const loadingState = (label: string) => (
    <View style={styles.emptyWrap}>
      <InukshukLoader />
      <Text variant="bodyMedium" style={styles.emptyText}>
        {label}
      </Text>
    </View>
  );

  const catalogUnavailable = () => {
    if (status === 'loading' || status === 'idle') return loadingState('Loading the map catalog…');
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
  };

  const searchEmptyState = () => {
    if (loadingShards || loadingSearch) {
      return (
        <View style={styles.emptyWrap}>
          <ActivityIndicator />
          <Text variant="bodyMedium" style={styles.emptyText}>
            Searching the catalog…
          </Text>
        </View>
      );
    }
    // What we may say depends on how much of the catalog was searched: the
    // store only reports 'complete' once every shard that could match is in.
    if (searchScope === 'complete') {
      return (
        <View style={styles.emptyWrap}>
          <Text variant="bodyMedium" style={styles.emptyText}>
            No maps match your search.
          </Text>
          <OrganisationMapsCta style={styles.ctaEmpty} />
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
   * Below a non-empty result list: a spinner while shards land, and — when a
   * query has matches but has not covered the catalog yet — the explicit
   * "there is more" affordance. Silence would let a partial result read as
   * the complete one.
   */
  const searchFooter = () => {
    if (sorted.length === 0) return null;
    if (loadingShards || loadingSearch) {
      return (
        <View style={styles.footer}>
          <ActivityIndicator size="small" />
        </View>
      );
    }
    if (searchScope === 'complete') return <OrganisationMapsCta style={styles.cta} />;
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

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <HeaderContours />
      {/* The shared tab header: same title and gear position as Library and Logbook. */}
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title="Explore" />
      </View>

      {/* Search and "Browse on the map" share ONE row (2.1.1, owner): the
        landing's separate pill row cost a whole band of height, and the
        header's map glyph duplicated it. The pill keeps its label (#474: an
        icon alone was missed). */}
      <View style={styles.searchRow} testID="explore-search-row">
        <View
          style={[
            styles.search,
            { backgroundColor: tokens.surface, borderColor: tokens.outlineVariant },
          ]}
        >
          <Icon source="magnify" size={20} color={tokens.inkMuted} />
          <TextInput
            placeholder="Search a place, a park, a map…"
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
        <BrowseOnMapButton
          label="Map"
          onPress={() => router.push(exploreMapHref())}
          accessibilityLabel="Browse all maps on the map"
        />
      </View>

      {fromCache && status === 'ready' && (
        <Text
          variant="bodySmall"
          style={[styles.cacheNote, { color: theme.colors.onSurfaceVariant }]}
        >
          Showing the saved catalog — downloads need a connection.
        </Text>
      )}

      {status !== 'ready' || index === null ? (
        catalogUnavailable()
      ) : searching ? (
        <CatalogResultsList
          data={sorted}
          flow={flow}
          ListEmptyComponent={searchEmptyState()}
          ListFooterComponent={searchFooter()}
        />
      ) : (
        <ExploreLanding index={index} items={items} />
      )}

      {flow.overlays}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
  },
  search: {
    flex: 1,
    minWidth: 0,
    height: target.min,
    borderRadius: target.min / 2,
    borderWidth: 1,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: { flex: 1, minWidth: 0, height: target.min, padding: 0, fontSize: 16 },
  clear: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  cacheNote: { paddingHorizontal: space.lg, paddingTop: space.sm },
  footer: { paddingVertical: 16, alignItems: 'center' },
  emptyWrap: { alignItems: 'center', gap: 12, paddingTop: 64, paddingHorizontal: 24 },
  emptyText: { textAlign: 'center' },
  cta: { marginHorizontal: space.lg, marginTop: space.lg },
  ctaEmpty: { alignSelf: 'stretch', marginTop: space.md },
});
