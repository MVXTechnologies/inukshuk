import { recoverFragmentsFromPublished } from './recoverFragments';
import type { CatalogItem, CatalogSource } from './schema';
import { planCatalogShards } from './shard';

const SOURCES: CatalogSource[] = [
  { id: 'alpha', name: 'Alpha', licence: 'CC0', attribution: 'Alpha Survey' },
  {
    id: 'beta',
    name: 'Beta',
    licence: 'CC-BY',
    attribution: 'Beta Maps',
    homepage: 'https://beta.test',
  },
];

/** A row in the generator's output key order, terrain last (as build-manifest appends it). */
function row(
  id: string,
  sourceId: string,
  lat: number,
  lon: number,
  extra: object = {},
): CatalogItem {
  return {
    id,
    sourceId,
    title: `${id} sheet`,
    category: 'topo',
    bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1],
    format: 'geopdf',
    packaging: 'none',
    url: `https://${sourceId}.test/${id}.pdf`,
    lang: 'en',
    kind: 'topo',
    ...extra,
  };
}

/** What build-manifest publishes for these rows: an index plus shard bodies. */
function publish(items: CatalogItem[], maxItems = 2) {
  const planned = planCatalogShards(items, { maxItems });
  const shards = new Map<string, unknown>();
  for (const shard of planned) {
    // Through JSON, exactly as the files on disk are read back.
    shards.set(shard.id, JSON.parse(JSON.stringify({ id: shard.id, items: shard.items })));
  }
  const categoryCounts: Record<string, number> = {};
  for (const item of items)
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
  const index = {
    schemaVersion: 2,
    generatedAt: '2026-09-29T00:00:00.000Z',
    sources: SOURCES,
    shards: planned.map((s) => ({
      id: s.id,
      category: s.category,
      path: `shards/${s.id}.json`,
      itemCount: s.items.length,
      ...(s.bbox !== undefined ? { bbox: s.bbox } : {}),
    })),
    categoryCounts,
  };
  return { index, shards };
}

const ITEMS: CatalogItem[] = [
  row('a-3', 'alpha', 46.8, -71.2, { scale: 50000, terrain: ['water'] }),
  row('a-1', 'alpha', 46.9, -71.3, { scale: 50000 }),
  row('a-2', 'alpha', 10.5, 20.5, { scale: 50000, terrain: ['mountains', 'coast'] }),
  row('b-1', 'beta', 46.7, -71.1, { region: 'CA-QC', terrain: ['glacier'] }),
  row('b-2', 'beta', -33.2, 151.1),
  { ...row('b-3', 'beta', 0, 0), category: 'forest' },
];

describe('recoverFragmentsFromPublished', () => {
  it('splits the published rows back into one fragment per declared source', () => {
    const { index, shards } = publish(ITEMS);
    const { fragments, counts, total } = recoverFragmentsFromPublished(index, shards);

    expect(total).toBe(6);
    expect([...fragments.keys()]).toEqual(['alpha', 'beta']);
    expect(counts).toEqual(
      new Map([
        ['alpha', 3],
        ['beta', 3],
      ]),
    );
    expect(fragments.get('beta')?.sources).toEqual([SOURCES[1]]);
    // Sorted by id, like the crawlers write them.
    expect(fragments.get('alpha')?.items.map((i) => i.id)).toEqual(['a-1', 'a-2', 'a-3']);
  });

  it('keeps every row verbatim, key order included, minus the recomputed terrain', () => {
    const { index, shards } = publish(ITEMS);
    const alpha = recoverFragmentsFromPublished(index, shards).fragments.get('alpha');
    const a3 = alpha?.items.find((i) => i.id === 'a-3');
    const { terrain: _terrain, ...expected } = ITEMS[0] as CatalogItem;
    expect(a3).toEqual(expected);
    expect(Object.keys(a3 ?? {})).toEqual(Object.keys(expected));
    expect(alpha?.items.some((i) => 'terrain' in i)).toBe(false);
  });

  it('round-trips: re-planning the recovered rows (terrain re-added) reproduces every shard byte for byte', () => {
    const { index, shards } = publish(ITEMS);
    const { fragments } = recoverFragmentsFromPublished(index, shards);
    const terrain = new Map(ITEMS.map((i) => [i.id, i.terrain]));
    // What build-manifest does: merge fragments, add the terrain pass's answer.
    const merged = [...fragments.values()]
      .flatMap((f) => f.items as unknown as CatalogItem[])
      .map((item) => {
        const found = terrain.get(item.id);
        return found === undefined ? item : { ...item, terrain: found };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const replanned = planCatalogShards(merged, { maxItems: 2 });

    expect(replanned.map((s) => s.id)).toEqual([...shards.keys()]);
    for (const shard of replanned) {
      expect(JSON.stringify({ id: shard.id, items: shard.items })).toBe(
        JSON.stringify(shards.get(shard.id)),
      );
    }
  });

  describe('refuses a published catalog that is not self-consistent', () => {
    function expectRefusal(mutate: (p: ReturnType<typeof publish>) => void, message: RegExp) {
      const published = publish(ITEMS);
      mutate(published);
      expect(() => recoverFragmentsFromPublished(published.index, published.shards)).toThrow(
        message,
      );
    }

    it('an index that does not parse', () => {
      expect(() => recoverFragmentsFromPublished({ schemaVersion: 9 }, new Map())).toThrow(
        /does not parse cleanly/,
      );
    });

    it('a listed shard with no body', () => {
      expectRefusal(
        ({ shards }) => shards.delete([...shards.keys()][0] ?? ''),
        /listed but missing/,
      );
    });

    it('a shard body the index does not list', () => {
      expectRefusal(
        ({ shards }) => shards.set('topo-n00e000-9', { id: 'topo-n00e000-9', items: [] }),
        /does not list it/,
      );
    });

    it('a body whose id disagrees with its file', () => {
      expectRefusal(({ shards }) => {
        const [id] = [...shards.keys()];
        shards.set(id ?? '', { id: 'other', items: [] });
      }, /body is not/);
    });

    it('an item count that disagrees with the index', () => {
      expectRefusal(({ index }) => {
        const first = index.shards[0];
        if (first !== undefined) first.itemCount += 1;
      }, /index says/);
    });

    it('a row the app parser would drop', () => {
      expectRefusal(({ index, shards }) => {
        const id = index.shards[0]?.id ?? '';
        const body = shards.get(id) as { items: Record<string, unknown>[] };
        const first = body.items[0];
        if (first !== undefined) first.url = 'ftp://nope';
      }, /non-http url/);
    });

    it('a row in a shard of another category', () => {
      expectRefusal(({ index, shards }) => {
        const id = index.shards.find((s) => s.category === 'topo')?.id ?? '';
        const body = shards.get(id) as { items: Record<string, unknown>[] };
        const first = body.items[0];
        if (first !== undefined) first.category = 'forest';
      }, /sits in topo shard/);
    });

    it('the same id in two shards', () => {
      expectRefusal(({ index, shards }) => {
        const [a, b] = index.shards;
        const bodyA = shards.get(a?.id ?? '') as { items: unknown[] };
        const bodyB = shards.get(b?.id ?? '') as { items: unknown[] };
        bodyB.items.push(bodyA.items[0]);
        if (b !== undefined) b.itemCount += 1;
      }, /more than one shard/);
    });

    it('category totals that disagree with the shards', () => {
      expectRefusal(({ index }) => {
        index.categoryCounts.topo = (index.categoryCounts.topo ?? 0) + 1;
      }, /categoryCounts\.topo/);
      expectRefusal(({ index }) => {
        delete index.categoryCounts.forest;
      }, /does not count/);
    });

    it('inline items (a fixture, not a generator output)', () => {
      expectRefusal(({ index }) => {
        Object.assign(index, { items: [ITEMS[1]] });
      }, /inline items/);
    });
  });
});
