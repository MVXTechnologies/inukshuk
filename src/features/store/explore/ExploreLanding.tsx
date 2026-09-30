import { countFacets, formatMapCount, kindFromCategory } from '@core/catalog/exploreFacets';
import { formatDistanceShort } from '@core/catalog/exploreFormat';
import { popularNearYou } from '@core/catalog/popularNear';
import {
  CATALOG_CATEGORIES,
  type CatalogIndex,
  type CatalogItem,
  type CatalogSource,
} from '@core/catalog/schema';
import {
  CATALOG_ACTIVITIES,
  CATALOG_ACTIVITY_ICONS,
  CATALOG_ACTIVITY_LABELS,
  CATALOG_KIND_LABELS,
  CATALOG_KINDS,
  CATALOG_TERRAIN_LABELS,
  CATALOG_TERRAINS,
  type CatalogActivity,
  type CatalogKind,
  type CatalogTerrain,
  type LinkOutCollection,
} from '@core/catalog/taxonomy';
import { formatByteSize } from '@core/storage/diskBudget';
import { useSettingsStore } from '@state/settingsStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ActivityTile,
  BrowseOnMapButton,
  ChipRow,
  CollectionRow,
  FilterChip,
  MapCard,
  SectionHeading,
  TerrainTile,
} from './ExploreParts';
import {
  exploreCollectionHref,
  exploreItemHref,
  exploreListHref,
  exploreMapHref,
} from './exploreRoutes';
import { LongTrailsSection } from '../trails/LongTrailsSection';
import { indexFacetCounts, itemFacets } from './facetsAdapter';
import { useLinkOutCollections } from './useLinkOutCollections';

/**
 * The Explore tab's Discover landing (#447, board `Main.dc.html`):
 *
 * 0. **Browse on the map** — a labelled pill into the map view;
 * 1. **Popular near you** — a carousel of the nearest maps, Canadian sources
 *    first, weighted by kind (`@core/catalog/popularNear`), with "See on map";
 * 2. **By activity** — the taxonomy's activities, 4 to a row;
 * 3. **By terrain** — coloured tiles with whole-catalog counts when known;
 * 4. **Collections** — link-out collections (Parcs Québec) first, then one
 *    row per publisher;
 * 5. **By type** — every kind with its total: the old category grid, and the
 *    way into "All maps".
 *
 * Works from the index's totals plus whatever shards are loaded — never from
 * the whole catalog. A facet the index counts is hidden at zero; one it does
 * not count (an index from before the taxonomy) shows only what the loaded
 * maps carry, without claiming totals, and disappears when they carry none.
 */

type CountSource = 'index' | 'loaded';

interface FacetEntry<T extends string> {
  value: T;
  /** Whole-catalog total; null when only the loaded maps were counted. */
  count: number | null;
}

/** Facet values to show: index totals when known (zero hidden), else loaded presence. */
function facetEntries<T extends string>(
  vocabulary: readonly T[],
  indexCounts: Partial<Record<T, number>> | undefined,
  loadedCounts: Partial<Record<T, number>>,
): { entries: FacetEntry<T>[]; from: CountSource } {
  if (indexCounts !== undefined) {
    return {
      from: 'index',
      entries: vocabulary
        .filter((v) => (indexCounts[v] ?? 0) > 0)
        .map((value) => ({ value, count: indexCounts[value] ?? 0 })),
    };
  }
  return {
    from: 'loaded',
    entries: vocabulary
      .filter((v) => (loadedCounts[v] ?? 0) > 0)
      .map((value) => ({ value, count: null })),
  };
}

/** Kind totals: the index's when it states them, else implied by `categoryCounts`. */
export function kindTotals(index: CatalogIndex | null): Partial<Record<CatalogKind, number>> {
  const stated = indexFacetCounts(index)?.kinds;
  if (stated !== undefined) return stated;
  const out: Partial<Record<CatalogKind, number>> = {};
  for (const category of CATALOG_CATEGORIES) {
    const n = index?.categoryCounts[category] ?? 0;
    if (n > 0) {
      const kind = kindFromCategory(category);
      out[kind] = (out[kind] ?? 0) + n;
    }
  }
  return out;
}

/** Items per publisher: stated by the index, or exact when there is one source. */
function sourceTotal(index: CatalogIndex, sourceId: string): number | null {
  const stated = indexFacetCounts(index)?.sources;
  if (stated !== undefined) return stated[sourceId] ?? 0;
  if (index.sources.length === 1) {
    return Object.values(index.categoryCounts).reduce((sum, n) => sum + (n ?? 0), 0);
  }
  return null;
}

/** "Topographic · NRCan CanTopo · 5.2 MB" */
function cardMeta(item: CatalogItem, source: CatalogSource | undefined): string {
  const kind = itemFacets(item).kind;
  return [
    kind !== null ? CATALOG_KIND_LABELS[kind] : undefined,
    source?.name,
    item.sizeBytes !== undefined ? formatByteSize(item.sizeBytes) : undefined,
  ]
    .filter((p): p is string => p !== undefined && p !== '')
    .join(' · ');
}

export function ExploreLanding({
  index,
  items,
}: {
  index: CatalogIndex;
  items: readonly CatalogItem[];
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const units = useSettingsStore((s) => s.units);
  const linkOut = useLinkOutCollections();

  const sourcesById = useMemo(
    () => new Map<string, CatalogSource>(index.sources.map((s) => [s.id, s])),
    [index],
  );
  const popular = useMemo(() => popularNearYou(items, position, itemFacets), [items, position]);
  const loadedCounts = useMemo(() => countFacets(items, itemFacets), [items]);
  const stated = useMemo(() => indexFacetCounts(index), [index]);
  const activities = facetEntries<CatalogActivity>(
    CATALOG_ACTIVITIES,
    stated?.activities,
    loadedCounts.activities,
  );
  const terrains = facetEntries<CatalogTerrain>(
    CATALOG_TERRAINS,
    stated?.terrains,
    loadedCounts.terrains,
  );
  const kinds = useMemo(() => {
    const totals = kindTotals(index);
    return CATALOG_KINDS.filter((k) => (totals[k] ?? 0) > 0).map((k) => ({
      kind: k,
      count: totals[k] ?? 0,
    }));
  }, [index]);

  // Four activity tiles per row inside the 16 dp gutters, 10 dp apart.
  const activityWidth = Math.floor((width - space.lg * 2 - 30) / 4);

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* The explicit way into the map view (#474): the header glyph alone was missed. */}
      <View style={styles.browse}>
        <BrowseOnMapButton
          onPress={() => router.push(exploreMapHref())}
          accessibilityLabel="Browse all maps on the map"
        />
      </View>

      {popular.length > 0 ? (
        <>
          <SectionHeading
            title="Popular near you"
            action={{
              label: 'See on map',
              accessibilityLabel: 'See maps near you on a map',
              onPress: () => router.push(exploreMapHref()),
            }}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.carousel}
            accessibilityLabel="Popular near you"
          >
            {popular.map(({ item, distanceMeters }) => (
              <MapCard
                key={item.id}
                id={item.id}
                title={item.title}
                meta={cardMeta(item, sourcesById.get(item.sourceId))}
                distance={formatDistanceShort(distanceMeters, units)}
                thumbnailUrl={item.thumbnailUrl}
                onPress={() => router.push(exploreItemHref(item.id))}
              />
            ))}
          </ScrollView>
        </>
      ) : (
        position === null && (
          <Text style={[styles.hint, { color: t.inkMuted }]}>
            Open the Map tab once to see the maps near you first.
          </Text>
        )
      )}

      {/* Long-distance trails near you (#467): hidden until the trail index is in. */}
      <LongTrailsSection />

      {activities.entries.length > 0 && (
        <>
          <SectionHeading title="By activity" />
          <View style={styles.activityGrid}>
            {activities.entries.map(({ value, count }) => (
              <ActivityTile
                key={value}
                label={CATALOG_ACTIVITY_LABELS[value]}
                icon={CATALOG_ACTIVITY_ICONS[value]}
                count={count}
                width={activityWidth}
                onPress={() => router.push(exploreListHref({ activity: value }))}
              />
            ))}
          </View>
        </>
      )}

      {terrains.entries.length > 0 && (
        <>
          <SectionHeading title="By terrain" />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.terrainRow}
          >
            {terrains.entries.map(({ value, count }) => (
              <TerrainTile
                key={value}
                label={CATALOG_TERRAIN_LABELS[value]}
                countLabel={count === null ? null : formatMapCount(count)}
                ground={t.explore.terrain[value]}
                onPress={() => router.push(exploreListHref({ terrain: value }))}
              />
            ))}
          </ScrollView>
        </>
      )}

      <SectionHeading title="Collections" />
      <View style={styles.collections}>
        {linkOut.collections.map((collection: LinkOutCollection) => (
          <CollectionRow
            key={`link-${collection.id}`}
            name={collection.name}
            meta={[
              `${collection.places.length} ${collection.places.length === 1 ? 'place' : 'places'}`,
              collection.blurb,
            ]
              .filter((p) => p !== '')
              .join(' · ')}
            badge={{ kind: 'park' }}
            onPress={() => router.push(exploreCollectionHref(collection.id))}
          />
        ))}
        {index.sources.map((source) => {
          const total = sourceTotal(index, source.id);
          if (total === 0) return null;
          return (
            <CollectionRow
              key={`source-${source.id}`}
              name={source.name}
              meta={[total !== null ? formatMapCount(total) : null, source.licence]
                .filter((p): p is string => p !== null && p !== '')
                .join(' · ')}
              badge={{ kind: 'source', id: source.id }}
              onPress={() => router.push(exploreListHref({ sourceId: source.id }))}
            />
          );
        })}
      </View>

      {kinds.length > 0 && (
        <>
          <SectionHeading
            title="By type"
            action={{
              label: 'All maps',
              accessibilityLabel: 'Browse all maps',
              onPress: () => router.push(exploreListHref({})),
            }}
          />
          <View style={styles.kinds}>
            <ChipRow>
              {kinds.map(({ kind, count }) => (
                <FilterChip
                  key={kind}
                  label={`${CATALOG_KIND_LABELS[kind]} · ${count.toLocaleString('en-US')}`}
                  // Distinct from the cards' "Topographic · …" meta lines, so
                  // a text match (Maestro) can only land on the chip.
                  accessibilityLabel={`${CATALOG_KIND_LABELS[kind]} maps, ${count}`}
                  on={false}
                  onPress={() => router.push(exploreListHref({ kind }))}
                />
              ))}
            </ChipRow>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  browse: { paddingHorizontal: space.lg, paddingTop: space.md },
  carousel: { paddingHorizontal: space.lg, gap: space.md },
  hint: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    fontSize: 13,
    lineHeight: 18,
  },
  activityGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: space.lg,
  },
  terrainRow: { paddingHorizontal: space.lg, gap: 10 },
  collections: { paddingHorizontal: space.lg, gap: 10 },
  kinds: { paddingHorizontal: space.lg },
});
