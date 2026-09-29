/**
 * Test-only fixtures for the explorer's screen tests (#447). Items carry the
 * data branch's optional taxonomy fields the way the wire will: as extra keys
 * on the parsed object, read through `facetsAdapter`.
 */
import type { CatalogIndex, CatalogItem } from '@core/catalog/schema';
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
