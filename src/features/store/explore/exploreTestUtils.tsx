/**
 * Test-only fixtures for the explorer's screen tests (#447). Items carry the
 * data branch's optional taxonomy fields the way the wire will: as extra keys
 * on the parsed object, read through `facetsAdapter`.
 */
import type { CatalogIndex, CatalogItem, CatalogShardRef } from '@core/catalog/schema';
import { useCatalogStore } from '@state/catalogStore';
import { act, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export const QUEBEC = { latitude: 46.8139, longitude: -71.2082 };

export function fixtureItem(
  id: string,
  title: string,
  lat: number,
  lon: number,
  extra: Record<string, unknown> = {},
): CatalogItem {
  return {
    id,
    sourceId: 'nrcan-cantopo',
    title,
    category: 'topo',
    bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1],
    format: 'geopdf',
    packaging: 'zip',
    sizeBytes: 5 * 1024 * 1024,
    url: `https://example.test/${id}.zip`,
    updatedAt: '2024-03-12',
    ...extra,
  } as CatalogItem;
}

export const lacBeauport = fixtureItem('cantopo-021l14', 'Québec — Lac-Beauport', 46.95, -71.3, {
  kind: 'topo',
  activities: ['hiking', 'ski'],
  terrain: ['mountains', 'water'],
  scale: 25000,
});
export const jacquesCartier = fixtureItem(
  'parks-jacques-cartier',
  'Jacques-Cartier trails',
  47.3,
  -71.35,
  { category: 'parks', kind: 'park', activities: ['hiking', 'paddling'], terrain: ['water'] },
);
export const saguenay = fixtureItem('chs-saguenay', 'Saguenay Fjord chart', 48.2, -70.1, {
  sourceId: 'chs-charts',
  category: 'nautical',
  kind: 'nautical',
  activities: ['paddling'],
  terrain: ['coast'],
});

export const fixtureItems = [lacBeauport, jacquesCartier, saguenay];

export function fixtureIndex(extra: Record<string, unknown> = {}): CatalogIndex {
  return {
    schemaVersion: 2,
    sources: [
      {
        id: 'nrcan-cantopo',
        name: 'NRCan CanTopo',
        licence: 'OGL-Canada-2.0',
        attribution: 'Natural Resources Canada',
        homepage: 'https://open.canada.ca',
      },
      { id: 'chs-charts', name: 'CHS Charts', licence: 'OGL', attribution: 'CHS' },
    ],
    shards: [],
    items: fixtureItems,
    categoryCounts: { topo: 1, parks: 1, nautical: 1 },
    ...extra,
  } as CatalogIndex;
}

/** Put the catalog store straight into a loaded state. */
export function seedCatalog(index: CatalogIndex, over: Record<string, unknown> = {}): void {
  useCatalogStore.setState({
    status: 'ready',
    index,
    items: index.items,
    fromCache: false,
    loadedShardIds: [],
    shardFailures: {},
    loadingShards: false,
    downloads: {},
    facets: null,
    facetsTried: false,
    ...over,
  });
}

export const sepaqRaw = {
  collections: [
    {
      id: 'sepaq',
      name: 'Parcs Québec',
      publisher: 'SÉPAQ',
      blurb: 'Maps on sepaq.com',
      homepage: 'https://www.sepaq.com',
      places: [
        {
          id: 'gaspesie',
          name: 'Parc national de la Gaspésie',
          type: 'National park',
          latitude: 48.95,
          longitude: -66.0,
          url: 'https://www.sepaq.com/pq/gas/',
        },
        {
          id: 'jacques-cartier',
          name: 'Parc national de la Jacques-Cartier',
          type: 'National park',
          latitude: 47.32,
          longitude: -71.33,
          url: 'https://www.sepaq.com/pq/jac/',
          activities: ['hiking', 'paddling'],
        },
        {
          id: 'laurentides',
          name: 'Réserve faunique des Laurentides',
          type: 'Wildlife reserve',
          latitude: 47.6,
          longitude: -71.5,
          url: 'https://www.sepaq.com/rf/lau/',
        },
      ],
    },
  ],
};

export async function mountWithProviders(ui: ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>{ui}</PaperProvider>
    </SafeAreaProvider>,
  );
}

/** Let pending promises (collections fetch, shard loads) settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * Realistic US Topo fixtures around Cupertino (the iOS simulator's default
 * location), shaped like the live `/catalog/v2` shards: topographic sheets
 * carry `terrain` but NO stored `activities` — "Hiking" reaches them only
 * through the terrain affinity (`itemActivities` in `@core/catalog/classify`),
 * which is exactly what the index's `activityCounts` and `facets.json` count.
 */
export const CUPERTINO = { latitude: 37.323, longitude: -122.0322 };

export function usTopo(
  slug: string,
  lat: number,
  lon: number,
  terrain: readonly string[] = [],
): CatalogItem {
  const name = slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return {
    id: `ustopo-ca-${slug}`,
    sourceId: 'usgs-ustopo',
    title: `${name}, California — US Topo`,
    category: 'topo',
    region: 'US-CA',
    bbox: [lon - 0.0625, lat - 0.0625, lon + 0.0625, lat + 0.0625],
    format: 'geopdf',
    packaging: 'none',
    sizeBytes: 52_000_000,
    url: `https://example.test/CA_${slug}.pdf`,
    updatedAt: '2021-12-15',
    lang: 'en',
    kind: 'topo',
    scale: 24000,
    ...(terrain.length > 0 ? { terrain } : {}),
  } as CatalogItem;
}

/** The shard nearest Cupertino: mountain, water, coast and plain sheets… */
export const cupertinoSheets = [
  usTopo('cupertino', 37.3125, -122.0625, ['mountains']),
  usTopo('castle-rock-ridge', 37.1875, -122.0625, ['mountains', 'water']),
  usTopo('san-jose-west', 37.3125, -121.9375),
  usTopo('palo-alto', 37.4375, -122.1875, ['coast']),
];
/** …a ring of plain valley sheets (no terrain at all)… */
export const valleySheets = [usTopo('lathrop', 37.8125, -121.3125)];
/** …and a far shard (Shasta) holding the only glacier. */
export const shastaSheets = [usTopo('mount-shasta', 41.4, -122.19, ['mountains', 'glacier'])];

const shardRef = (
  id: string,
  count: number,
  bbox: [number, number, number, number],
): CatalogShardRef => ({
  id,
  category: 'topo',
  path: `shards/${id}.json`,
  itemCount: count,
  bbox,
  byteSize: 1_000,
});

export const cupertinoShards: CatalogShardRef[] = [
  shardRef('topo-n30w130-33', cupertinoSheets.length, [-122.5, 37.125, -121.875, 37.5]),
  shardRef('topo-n30w130-34', valleySheets.length, [-121.5, 37.5, -121, 38]),
  shardRef('topo-n40w130-1', shastaSheets.length, [-122.5, 41, -122, 41.5]),
];

/** `facets.json` for {@link cupertinoShards}, counted the way the build counts it. */
export const cupertinoFacetsRaw = {
  schemaVersion: 1,
  shards: {
    'topo-n30w130-33': {
      kinds: { topo: 4 },
      activities: { hiking: 2, paddling: 2, fishing: 1 },
      terrain: { mountains: 2, water: 1, coast: 1 },
    },
    'topo-n30w130-34': { kinds: { topo: 1 } },
    'topo-n40w130-1': {
      kinds: { topo: 1 },
      activities: { hiking: 1, climbing: 1 },
      terrain: { mountains: 1, glacier: 1 },
    },
  },
};

export function cupertinoIndex(extra: Record<string, unknown> = {}): CatalogIndex {
  return {
    schemaVersion: 2,
    sources: [
      { id: 'usgs-ustopo', name: 'USGS US Topo', licence: 'Public domain', attribution: 'USGS' },
    ],
    shards: cupertinoShards,
    items: [],
    facets: { path: 'facets.json', byteSize: 400 },
    categoryCounts: { topo: 6 },
    kindCounts: { topo: 6 },
    activityCounts: { hiking: 3, paddling: 2, fishing: 1, climbing: 1 },
    terrainCounts: { mountains: 3, water: 1, coast: 1, glacier: 1 },
    ...extra,
  } as CatalogIndex;
}

/** A `loadCatalogShard` stand-in serving {@link cupertinoShards}. */
export function serveCupertinoShard(shard: CatalogShardRef) {
  const items: Record<string, CatalogItem[]> = {
    'topo-n30w130-33': cupertinoSheets,
    'topo-n30w130-34': valleySheets,
    'topo-n40w130-1': shastaSheets,
  };
  const found = items[shard.id];
  return Promise.resolve(
    found === undefined ? null : { items: found, fromCache: false, warnings: [] },
  );
}
