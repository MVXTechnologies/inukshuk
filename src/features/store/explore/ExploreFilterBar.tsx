import { countFacets, isExploreFilterEmpty, type ExploreFilter } from '@core/catalog/exploreFacets';
import type { CatalogItem, CatalogSource } from '@core/catalog/schema';
import {
  CATALOG_ACTIVITIES,
  CATALOG_ACTIVITY_LABELS,
  CATALOG_KIND_LABELS,
  CATALOG_KINDS,
  CATALOG_TERRAIN_LABELS,
  CATALOG_TERRAINS,
} from '@core/catalog/taxonomy';
import { space } from '@ui/tokens';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { FilterChip } from './ExploreParts';
import { itemFacets } from './facetsAdapter';

/**
 * The explorer's filter chips (#447): "All maps", then one chip per facet —
 * Type, Activity, Terrain, Source. An unset facet chip opens a second row of
 * its values (only values the loaded maps actually carry, with how many); a
 * set one shows its value and clears on tap. Inline rows, not a menu: no
 * Portal, nothing to swallow touches, and it reads the same on both OSes.
 */

type Facet = 'kind' | 'activity' | 'terrain' | 'source';

const FACET_LABELS: Record<Facet, string> = {
  kind: 'Type',
  activity: 'Activity',
  terrain: 'Terrain',
  source: 'Source',
};

interface Option {
  key: string;
  label: string;
  count: number;
  apply: (filter: ExploreFilter) => ExploreFilter;
}

/** The filter with one facet cleared. */
function without(filter: ExploreFilter, facet: Facet): ExploreFilter {
  const next = { ...filter };
  if (facet === 'kind') delete next.kind;
  if (facet === 'activity') delete next.activity;
  if (facet === 'terrain') delete next.terrain;
  if (facet === 'source') delete next.sourceId;
  return next;
}

export function ExploreFilterBar({
  filter,
  onChange,
  items,
  sources,
}: {
  filter: ExploreFilter;
  onChange: (next: ExploreFilter) => void;
  /** The loaded maps the options (and their counts) are drawn from. */
  items: readonly CatalogItem[];
  sources: readonly CatalogSource[];
}) {
  const [open, setOpen] = useState<Facet | null>(null);
  const counts = useMemo(() => countFacets(items, itemFacets), [items]);

  const valueLabel = (facet: Facet): string | null => {
    if (facet === 'kind' && filter.kind != null) return CATALOG_KIND_LABELS[filter.kind];
    if (facet === 'activity' && filter.activity != null) {
      return CATALOG_ACTIVITY_LABELS[filter.activity];
    }
    if (facet === 'terrain' && filter.terrain != null)
      return CATALOG_TERRAIN_LABELS[filter.terrain];
    if (facet === 'source' && filter.sourceId != null) {
      return sources.find((s) => s.id === filter.sourceId)?.name ?? filter.sourceId;
    }
    return null;
  };

  const options = (facet: Facet): Option[] => {
    switch (facet) {
      case 'kind':
        return CATALOG_KINDS.filter((k) => (counts.kinds[k] ?? 0) > 0).map((k) => ({
          key: k,
          label: CATALOG_KIND_LABELS[k],
          count: counts.kinds[k] ?? 0,
          apply: (f) => ({ ...f, kind: k }),
        }));
      case 'activity':
        return CATALOG_ACTIVITIES.filter((a) => (counts.activities[a] ?? 0) > 0).map((a) => ({
          key: a,
          label: CATALOG_ACTIVITY_LABELS[a],
          count: counts.activities[a] ?? 0,
          apply: (f) => ({ ...f, activity: a }),
        }));
      case 'terrain':
        return CATALOG_TERRAINS.filter((v) => (counts.terrains[v] ?? 0) > 0).map((v) => ({
          key: v,
          label: CATALOG_TERRAIN_LABELS[v],
          count: counts.terrains[v] ?? 0,
          apply: (f) => ({ ...f, terrain: v }),
        }));
      case 'source':
        return sources
          .filter((s) => (counts.sources[s.id] ?? 0) > 0)
          .map((s) => ({
            key: s.id,
            label: s.name,
            count: counts.sources[s.id] ?? 0,
            apply: (f) => ({ ...f, sourceId: s.id }),
          }));
    }
  };

  // A facet chip is worth showing when it is set, or has something to offer.
  const facets = (['kind', 'activity', 'terrain', 'source'] as const).filter(
    (facet) => valueLabel(facet) !== null || options(facet).length > 0,
  );
  const openOptions = open !== null ? options(open) : [];

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        <FilterChip
          label="All maps"
          on={isExploreFilterEmpty({ ...filter, text: '' })}
          onPress={() => {
            setOpen(null);
            onChange(filter.text !== undefined ? { text: filter.text } : {});
          }}
        />
        {facets.map((facet) => {
          const value = valueLabel(facet);
          return value !== null ? (
            <FilterChip
              key={facet}
              label={value}
              on
              icon="close"
              accessibilityLabel={`${value}, clear ${FACET_LABELS[facet].toLowerCase()} filter`}
              onPress={() => {
                setOpen(null);
                onChange(without(filter, facet));
              }}
            />
          ) : (
            <FilterChip
              key={facet}
              label={FACET_LABELS[facet]}
              on={false}
              icon={open === facet ? 'chevron-up' : 'chevron-down'}
              accessibilityLabel={`Filter by ${FACET_LABELS[facet].toLowerCase()}`}
              onPress={() => setOpen(open === facet ? null : facet)}
            />
          );
        })}
      </ScrollView>
      {openOptions.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
          keyboardShouldPersistTaps="handled"
        >
          {openOptions.map((option) => (
            <FilterChip
              key={option.key}
              label={`${option.label} · ${option.count.toLocaleString('en-US')}`}
              accessibilityLabel={`${option.label}, ${option.count} maps`}
              on={false}
              onPress={() => {
                setOpen(null);
                onChange(option.apply(filter));
              }}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
});
