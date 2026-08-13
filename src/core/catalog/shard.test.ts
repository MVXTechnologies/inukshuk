import type { CatalogBbox, CatalogItem, CatalogShardRef } from './schema';
import {
  cellBbox,
  cellId,
  cellSizeDeg,
  distanceToBboxMeters,
  planCatalogShards,
  rankShardsByDistance,
  resolveCatalogUrl,
  sameCatalogOrigin,
  rootCellFor,
  selectShards,
  subdivideCell,
} from './shard';

function item(
  id: string,
  bbox: CatalogBbox | null,
  category: CatalogItem['category'],
): CatalogItem {
  return {
    id,
    sourceId: 'src',
    title: id,
    category,
    format: 'geopdf',
    packaging: 'none',
    url: `https://example.test/${id}.pdf`,
    ...(bbox !== null ? { bbox } : {}),
  };
}

/** A small sheet centred on (lat, lon). */
function sheetAt(id: string, lat: number, lon: number, category: CatalogItem['category'] = 'topo') {
  return item(id, [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05], category);
}

function ref(id: string, bbox: CatalogBbox | null, extra?: Partial<CatalogShardRef>) {
  return {
    id,
    category: 'topo' as const,
    path: `shards/${id}.json`,
    itemCount: 1,
    ...(bbox !== null ? { bbox } : {}),
    ...extra,
  } satisfies CatalogShardRef;
}

describe('cell geometry', () => {
  it('roots a point in its 10° cell, hemisphere-prefixed', () => {
    expect(cellId(rootCellFor({ latitude: 46.8, longitude: -71.2 }))).toBe('n40w080');
    expect(cellId(rootCellFor({ latitude: -33.9, longitude: 18.4 }))).toBe('s40e010');
    expect(cellId(rootCellFor({ latitude: 0, longitude: 0 }))).toBe('n00e000');
  });

  it('floors negatives outward, so a cell always contains its point', () => {
    const cell = rootCellFor({ latitude: -0.5, longitude: -0.5 });
    const [west, south, east, north] = cellBbox(cell);
    expect([west, south, east, north]).toEqual([-10, -10, 0, 0]);
    expect(cellId(cell)).toBe('s10w010');
  });

  it('halves the side and moves the origin per quadrant', () => {
    const root = rootCellFor({ latitude: 45, longitude: -75 });
    const [sw, se, nw, ne] = subdivideCell(root);
    expect(sw && cellBbox(sw)).toEqual([-80, 40, -75, 45]);
    expect(se && cellBbox(se)).toEqual([-75, 40, -70, 45]);
    expect(nw && cellBbox(nw)).toEqual([-80, 45, -75, 50]);
    expect(ne && cellBbox(ne)).toEqual([-75, 45, -70, 50]);
    expect(ne && cellId(ne)).toBe('n40w080-3');
    expect(ne && cellSizeDeg(ne)).toBe(5);
  });

  it('names deeper levels by their quadrant path', () => {
    const root = rootCellFor({ latitude: 45, longitude: -75 });
    const child = subdivideCell(root)[3];
    const grandchild = child === undefined ? undefined : subdivideCell(child)[1];
    expect(grandchild && cellId(grandchild)).toBe('n40w080-31');
    expect(grandchild && cellSizeDeg(grandchild)).toBe(2.5);
  });

  it('produces ids the manifest parser accepts as shard ids', () => {
    for (const point of [
      { latitude: 46.8, longitude: -71.2 },
      { latitude: -41, longitude: 174 },
      { latitude: 5, longitude: -5 },
    ]) {
      expect(cellId(rootCellFor(point))).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    }
  });
});

describe('planCatalogShards', () => {
  it('keeps a small catalog in one shard per category', () => {
    const shards = planCatalogShards([
      sheetAt('a', 46.8, -71.2),
      sheetAt('b', 46.9, -71.3),
      sheetAt('c', 46.8, -71.2, 'nautical'),
    ]);
    expect(shards.map((s) => s.id)).toEqual(['nautical-n40w080', 'topo-n40w080']);
    expect(shards[1]?.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('subdivides a cell that overflows the item cap', () => {
    // 12 sheets spread across the four quadrants of n40w080, cap 4.
    const items = [
      ...[0, 1, 2].map((i) => sheetAt(`sw${i}`, 41 + i * 0.1, -79 + i * 0.1)),
      ...[0, 1, 2].map((i) => sheetAt(`se${i}`, 41 + i * 0.1, -74 + i * 0.1)),
      ...[0, 1, 2].map((i) => sheetAt(`nw${i}`, 46 + i * 0.1, -79 + i * 0.1)),
      ...[0, 1, 2].map((i) => sheetAt(`ne${i}`, 46 + i * 0.1, -74 + i * 0.1)),
    ];
    const shards = planCatalogShards(items, { maxItems: 4 });
    expect(shards.map((s) => s.id)).toEqual([
      'topo-n40w080-0',
      'topo-n40w080-1',
      'topo-n40w080-2',
      'topo-n40w080-3',
    ]);
    for (const shard of shards) expect(shard.items).toHaveLength(3);
  });

  it('stops subdividing at the minimum cell size, accepting a full leaf', () => {
    // 50 sheets in one tiny harbour: no depth of subdivision can split them.
    const items = Array.from({ length: 50 }, (_, i) =>
      sheetAt(`h${String(i).padStart(2, '0')}`, 46.801, -71.201, 'nautical'),
    );
    const shards = planCatalogShards(items, { maxItems: 4, minCellDeg: 1.25 });
    expect(shards).toHaveLength(1);
    expect(shards[0]?.items).toHaveLength(50);
    expect(cellSizeDeg({ rootWest: -80, rootSouth: 40, path: [0, 0, 0] })).toBe(1.25);
  });

  it('publishes each shard bbox as the union of its items, not the cell', () => {
    const shards = planCatalogShards([sheetAt('a', 46.8, -71.2), sheetAt('b', 41.0, -79.0)]);
    const bbox = shards[0]?.bbox ?? [0, 0, 0, 0];
    // Tight around the two sheets — nowhere near the 10° cell [-80,40,-70,50].
    expect(bbox[0]).toBeCloseTo(-79.05, 6);
    expect(bbox[1]).toBeCloseTo(40.95, 6);
    expect(bbox[2]).toBeCloseTo(-71.15, 6);
    expect(bbox[3]).toBeCloseTo(46.85, 6);
  });

  it('collects bbox-less items into one nogeo shard per category', () => {
    const shards = planCatalogShards([
      item('x', null, 'parks'),
      item('y', null, 'parks'),
      sheetAt('z', 46.8, -71.2, 'parks'),
    ]);
    expect(shards.map((s) => s.id)).toEqual(['parks-n40w080', 'parks-nogeo']);
    const nogeo = shards.find((s) => s.id === 'parks-nogeo');
    expect(nogeo?.bbox).toBeUndefined();
    expect(nogeo?.items.map((i) => i.id)).toEqual(['x', 'y']);
  });

  it('is deterministic — same input, identical plan', () => {
    const items = Array.from({ length: 40 }, (_, i) => sheetAt(`s${i}`, 40 + (i % 20) * 0.5, -79));
    const a = planCatalogShards(items, { maxItems: 8 });
    const b = planCatalogShards([...items].reverse(), { maxItems: 8 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('resolveCatalogUrl', () => {
  const index = 'https://inukshuk.mvxtechnologies.com/catalog/v2/index.json';

  it('resolves a shard path next to the index document', () => {
    expect(resolveCatalogUrl(index, 'shards/topo-n40w080.json')).toBe(
      'https://inukshuk.mvxtechnologies.com/catalog/v2/shards/topo-n40w080.json',
    );
  });

  it('works for the loopback fixture server too', () => {
    expect(resolveCatalogUrl('http://127.0.0.1:8787/index.json', 'shards/a.json')).toBe(
      'http://127.0.0.1:8787/shards/a.json',
    );
  });

  it('ignores query strings and fragments on the index URL', () => {
    expect(resolveCatalogUrl(`${index}?v=3#top`, 'shards/a.json')).toBe(
      'https://inukshuk.mvxtechnologies.com/catalog/v2/shards/a.json',
    );
  });

  it('refuses anything that is not a plain relative path', () => {
    expect(resolveCatalogUrl(index, '')).toBeNull();
    expect(resolveCatalogUrl(index, '/etc/passwd')).toBeNull();
    expect(resolveCatalogUrl(index, '../../secret.json')).toBeNull();
    expect(resolveCatalogUrl(index, 'https://evil.test/shard.json')).toBeNull();
    expect(resolveCatalogUrl(index, 'file:///etc/passwd')).toBeNull();
  });

  it('refuses a base URL with no path to hang the shard off', () => {
    expect(resolveCatalogUrl('https://example.test', 'shards/a.json')).toBeNull();
  });
});

describe('sameCatalogOrigin', () => {
  const v1 = 'https://inukshuk.mvxtechnologies.com/catalog/v1/manifest.json';
  const v2 = 'https://inukshuk.mvxtechnologies.com/catalog/v2/index.json';

  it('treats a moved path on one host as the same catalog (the v1 → v2 upgrade)', () => {
    expect(sameCatalogOrigin(v1, v2)).toBe(true);
  });

  it('ignores case in scheme and host, and query strings', () => {
    expect(sameCatalogOrigin('HTTPS://Inukshuk.MVXTechnologies.com/a.json', v2)).toBe(true);
    expect(sameCatalogOrigin(`${v1}?v=3`, v2)).toBe(true);
  });

  it('separates different hosts, ports and schemes', () => {
    expect(sameCatalogOrigin(v2, 'https://evil.test/catalog/v2/index.json')).toBe(false);
    expect(sameCatalogOrigin('http://127.0.0.1:8787/index.json', 'http://127.0.0.1:9999/i.json')).toBe(
      false,
    );
    expect(sameCatalogOrigin('http://inukshuk.mvxtechnologies.com/a.json', v2)).toBe(false);
  });

  it('refuses anything that is not an absolute http(s) URL', () => {
    expect(sameCatalogOrigin('file:///tmp/a.json', 'file:///tmp/b.json')).toBe(false);
    expect(sameCatalogOrigin('shards/a.json', v2)).toBe(false);
  });
});

describe('distanceToBboxMeters', () => {
  it('is zero inside the box', () => {
    expect(distanceToBboxMeters([-72, 46, -71, 47], { latitude: 46.5, longitude: -71.5 })).toBe(0);
  });

  it('measures to the nearest edge outside it', () => {
    const oneDegNorth = distanceToBboxMeters([-72, 46, -71, 47], {
      latitude: 48,
      longitude: -71.5,
    });
    expect(oneDegNorth).toBeGreaterThan(105_000);
    expect(oneDegNorth).toBeLessThan(115_000);
  });
});

describe('rankShardsByDistance', () => {
  const near = ref('topo-n40w080', [-72, 46, -71, 47]);
  const far = ref('topo-n30e000', [0, 30, 1, 31]);
  const nogeo = ref('topo-nogeo', null);

  it('sorts nearest-first and parks bbox-less shards at the end', () => {
    const ranked = rankShardsByDistance([far, nogeo, near], { latitude: 46.5, longitude: -71.5 });
    expect(ranked.map((s) => s.id)).toEqual(['topo-n40w080', 'topo-n30e000', 'topo-nogeo']);
  });

  it('falls back to a stable alphabetical order with no position', () => {
    expect(rankShardsByDistance([far, near, nogeo], null).map((s) => s.id)).toEqual([
      'topo-n30e000',
      'topo-n40w080',
      'topo-nogeo',
    ]);
  });

  it('never mutates its input', () => {
    const input = [far, near];
    rankShardsByDistance(input, { latitude: 46.5, longitude: -71.5 });
    expect(input.map((s) => s.id)).toEqual(['topo-n30e000', 'topo-n40w080']);
  });
});

describe('selectShards', () => {
  const origin = { latitude: 46.5, longitude: -71.5 };
  const topoNear = ref('topo-n40w080', [-72, 46, -71, 47], { byteSize: 40_000 });
  const topoNext = ref('topo-n40w090', [-92, 46, -91, 47], { byteSize: 40_000 });
  const nautNear = ref('nautical-n40w080', [-72, 46, -71, 47], {
    category: 'nautical',
    byteSize: 10_000,
  });

  it('restricts to one category when asked', () => {
    const picked = selectShards([topoNear, topoNext, nautNear], origin, {
      category: 'nautical',
      limit: 5,
    });
    expect(picked.map((s) => s.id)).toEqual(['nautical-n40w080']);
  });

  it('gives every category a turn when selecting across all of them', () => {
    const picked = selectShards([topoNear, topoNext, nautNear], origin, { limit: 2 });
    expect(picked.map((s) => s.category).sort()).toEqual(['nautical', 'topo']);
  });

  it('honours the count cap', () => {
    expect(selectShards([topoNear, topoNext, nautNear], origin, { limit: 1 })).toHaveLength(1);
  });

  it('stops on the byte budget but always takes at least one shard', () => {
    const picked = selectShards([topoNear, topoNext, nautNear], origin, {
      limit: 9,
      byteBudget: 45_000,
    });
    expect(picked.length).toBeGreaterThanOrEqual(1);
    const total = picked.reduce((sum, s) => sum + (s.byteSize ?? 0), 0);
    expect(total).toBeLessThanOrEqual(50_000);

    const single = selectShards([topoNear], origin, { limit: 9, byteBudget: 1 });
    expect(single).toHaveLength(1);
  });
});
