import {
  boundsCenter,
  boundsContain,
  boundsIntersect,
  catalogPointCollection,
  clusterIdOf,
  clusterTapZoom,
  footprintFeature,
  itemsInBounds,
  normalizeBounds,
  pendingShardCountInBounds,
  pointItemIdOf,
  selectShardsInBounds,
  shardsInBounds,
} from './exploreMap';
import type { CatalogBbox, CatalogItem, CatalogShardRef } from './schema';

const shard = (id: string, bbox: CatalogBbox | undefined, byteSize = 100): CatalogShardRef => ({
  id,
  category: 'topo',
  path: `shards/${id}.json`,
  itemCount: 1,
  ...(bbox !== undefined ? { bbox } : {}),
  byteSize,
});

const item = (id: string, bbox?: CatalogBbox): CatalogItem => ({
  id,
  sourceId: 's',
  title: id,
  category: 'topo',
  format: 'geopdf',
  packaging: 'none',
  url: `https://example.test/${id}.pdf`,
  ...(bbox !== undefined ? { bbox } : {}),
});

describe('bounds', () => {
  it('normalizes a world view and wraps longitudes', () => {
    expect(normalizeBounds([-400, -95, 400, 95])).toEqual([-180, -90, 180, 90]);
    expect(normalizeBounds([170, 10, 190, 20])).toEqual([170, 10, -170, 20]);
    expect(normalizeBounds([-75, 45, -70, 48])).toEqual([-75, 45, -70, 48]);
  });

  it('intersects, including across the antimeridian', () => {
    expect(boundsIntersect([-75, 45, -70, 48], [-71, 47, -69, 49])).toBe(true);
    expect(boundsIntersect([-75, 45, -70, 48], [-60, 45, -55, 48])).toBe(false);
    expect(boundsIntersect([-75, 45, -70, 48], [-75, 49, -70, 50])).toBe(false);
    // A view from 170°E to 170°W reaches a sheet at 175°W.
    expect(boundsIntersect([170, 50, -170, 60], [-176, 55, -174, 56])).toBe(true);
    expect(boundsIntersect([170, 50, -170, 60], [0, 55, 1, 56])).toBe(false);
  });

  it('contains points and finds centres across the seam', () => {
    expect(boundsContain([170, 50, -170, 60], { latitude: 55, longitude: -175 })).toBe(true);
    expect(boundsContain([170, 50, -170, 60], { latitude: 55, longitude: 0 })).toBe(false);
    expect(boundsCenter([170, 50, -170, 60])).toEqual({ latitude: 55, longitude: 180 });
    expect(boundsCenter([-75, 45, -71, 47])).toEqual({ latitude: 46, longitude: -73 });
  });
});

describe('shards for "Search this area"', () => {
  const view: CatalogBbox = [-72, 46, -70, 48];
  const shards = [
    shard('inside', [-71.5, 46.5, -71, 47]),
    shard('edge', [-73, 47, -71.9, 48]),
    shard('far', [-120, 30, -110, 40]),
    shard('nogeo', undefined),
  ];

  it('only picks shards reaching into the view', () => {
    expect(shardsInBounds(shards, view).map((s) => s.id)).toEqual(['inside', 'edge']);
  });

  it('ranks from the view centre and respects the budgets', () => {
    expect(selectShardsInBounds(shards, view, { limit: 6 }).map((s) => s.id)).toEqual([
      'inside',
      'edge',
    ]);
    expect(selectShardsInBounds(shards, view, { limit: 1 }).map((s) => s.id)).toEqual(['inside']);
    // The first shard always fits; the second would break a 150-byte budget.
    expect(
      selectShardsInBounds(shards, view, { limit: 6, byteBudget: 150 }).map((s) => s.id),
    ).toEqual(['inside']);
  });

  it('counts what is still to load', () => {
    expect(pendingShardCountInBounds(shards, view, new Set())).toBe(2);
    expect(pendingShardCountInBounds(shards, view, new Set(['inside']))).toBe(1);
    expect(pendingShardCountInBounds(shards, view, new Set(), 'nautical')).toBe(0);
  });
});

describe('points and footprints', () => {
  it('builds one point per placeable item at its centre', () => {
    const fc = catalogPointCollection([item('a', [-72, 46, -70, 48]), item('nogeo')]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.geometry.coordinates).toEqual([-71, 47]);
    expect(fc.features[0]!.properties.id).toBe('a');
  });

  it('keeps only items centred in the view', () => {
    const inView = itemsInBounds(
      [item('in', [-71.2, 46.8, -71, 47]), item('out', [-60, 46, -59, 47]), item('nogeo')],
      [-72, 46, -70, 48],
    );
    expect(inView.map((i) => i.id)).toEqual(['in']);
  });

  it('closes the footprint ring', () => {
    const ring = footprintFeature([-72, 46, -70, 48]).geometry.coordinates[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });
});

describe('cluster taps', () => {
  it('zooms to the expansion zoom, at least one level deeper, never past the cap', () => {
    expect(clusterTapZoom(9, 6)).toBe(9);
    expect(clusterTapZoom(6, 6)).toBe(7);
    expect(clusterTapZoom(20, 10)).toBe(16);
    expect(clusterTapZoom(null, 5)).toBe(7);
    expect(clusterTapZoom(undefined, Number.NaN)).toBe(2);
  });

  it('reads cluster and point ids off features', () => {
    expect(clusterIdOf({ properties: { cluster: true, cluster_id: 42, point_count: 3 } })).toBe(42);
    expect(clusterIdOf({ properties: { id: 'a' } })).toBeNull();
    expect(pointItemIdOf({ properties: { id: 'a' } })).toBe('a');
    expect(pointItemIdOf({ properties: { cluster: true, cluster_id: 1 } })).toBeNull();
    expect(pointItemIdOf({ properties: null })).toBeNull();
  });
});
