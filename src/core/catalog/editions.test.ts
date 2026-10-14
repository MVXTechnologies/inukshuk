import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildCatalogEdition,
  needsCreditRendering,
  serializeWithStableTimestamp,
  splitCatalogEditions,
  type CatalogEditionOutput,
} from './editions';
import { parseCatalogIndex, type CatalogItem, type CatalogSource } from './schema';

/**
 * The generator's edition split (#680). Apps before 2.5.2 read v2 and cannot
 * render the author credit or "Available free at cartespleinair.org" the
 * publisher's permission requires, so v2 must never carry a Cartes Plein-air
 * row; v3 carries everything and shares v2's identical shards.
 */

/** The real crawled fragment, committed: the rows that must stay out of v2. */
const cpa = JSON.parse(
  readFileSync(join(__dirname, '../../../scripts/catalog/fragments/cartes-plein-air.json'), 'utf8'),
) as { sources: CatalogSource[]; items: CatalogItem[] };

const topoSource: CatalogSource = {
  id: 'nrcan-cantopo',
  name: 'NRCan CanTopo',
  licence: 'OGL-Canada-2.0',
  attribution: 'Natural Resources Canada',
};

/** A dozen topo sheets around Québec City, where most river maps are too. */
const topoItems: CatalogItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: `cantopo-${String(i).padStart(2, '0')}`,
  sourceId: 'nrcan-cantopo',
  title: `CanTopo sheet ${i}`,
  category: 'topo',
  kind: 'topo',
  format: 'geopdf',
  packaging: 'zip',
  url: `https://ftp.maps.canada.ca/sheet-${i}.zip`,
  bbox: [-72 + i * 0.5, 46, -71.5 + i * 0.5, 46.25],
}));

const NOW = '2026-10-14T00:00:00.000Z';
const LATER = '2026-10-21T00:00:00.000Z';

const allSources = [topoSource, ...cpa.sources];
const allItems = [...topoItems, ...cpa.items].sort((a, b) => a.id.localeCompare(b.id));

function buildBoth(
  items: CatalogItem[],
  now: string,
  previous?: { legacy?: CatalogEditionOutput; credited?: CatalogEditionOutput },
): { legacy: CatalogEditionOutput; credited: CatalogEditionOutput } {
  const split = splitCatalogEditions(allSources, items);
  const legacy = buildCatalogEdition({
    ...split.legacy,
    collections: [],
    now,
    previousIndex: previous?.legacy?.files.get('index.json'),
  });
  const credited = buildCatalogEdition({
    ...split.credited,
    collections: [],
    now,
    previousIndex: previous?.credited?.files.get('index.json'),
    sibling: { prefix: '../v2/', shardBodies: legacy.shardBodies },
  });
  return { legacy, credited };
}

describe('needsCreditRendering', () => {
  it('is true for a source that asks for a "free at" line (Cartes Plein-air)', () => {
    const source = cpa.sources[0];
    if (source === undefined) throw new Error('fragment has no source');
    expect(needsCreditRendering(source, [])).toBe(true);
  });

  it('is true for a source whose rows name an author, even without freeAt', () => {
    const credited = { ...topoItems[0], author: 'Someone' } as CatalogItem;
    expect(needsCreditRendering(topoSource, [credited])).toBe(true);
  });

  it('is false for a plain open-data source', () => {
    expect(needsCreditRendering(topoSource, topoItems)).toBe(false);
  });
});

describe('splitCatalogEditions', () => {
  it('keeps every Cartes Plein-air source and row out of the legacy edition', () => {
    const split = splitCatalogEditions(allSources, allItems);
    expect(split.creditedOnlySourceIds).toEqual(['cartes-plein-air']);
    expect(split.legacy.sources.map((s) => s.id)).toEqual(['nrcan-cantopo']);
    expect(split.legacy.items).toEqual(topoItems);
    expect(split.credited.items).toHaveLength(topoItems.length + cpa.items.length);
    expect(cpa.items.length).toBeGreaterThan(300);
  });

  it('drops a stray authored row of a plain source from legacy, never silently uncredited', () => {
    const authored = {
      ...topoItems[0],
      id: 'cantopo-authored',
      author: 'A. Author',
    } as CatalogItem;
    const split = splitCatalogEditions([topoSource], [...topoItems, authored]);
    // The whole source now needs credit rendering, so v2 lists none of it.
    expect(split.legacy.items).toEqual([]);
    expect(split.credited.items).toHaveLength(topoItems.length + 1);
  });
});

describe('buildCatalogEdition: the two published editions', () => {
  const { legacy, credited } = buildBoth(allItems, NOW);

  it('writes no Cartes Plein-air byte anywhere in v2', () => {
    for (const [path, body] of legacy.files) {
      expect([path, body.includes('cartes-plein-air')]).toEqual([path, false]);
      expect([path, body.includes('cartespleinair')]).toEqual([path, false]);
      expect([path, body.includes('"author"')]).toEqual([path, false]);
      expect([path, body.includes('"freeAt"')]).toEqual([path, false]);
    }
    expect([...legacy.files.keys()].some((p) => p.includes('river'))).toBe(false);
    expect(legacy.sharedShardCount).toBe(0);
  });

  it('v2 search and facet digests only name v2 shards', () => {
    const ids = new Set(legacy.refs.map((r) => r.id));
    const digest = JSON.parse(legacy.files.get('search.json') ?? '{}') as { shardIds: string[] };
    expect(digest.shardIds.every((id) => ids.has(id))).toBe(true);
    const facets = JSON.parse(legacy.files.get('facets.json') ?? '{}') as {
      shards: Record<string, unknown>;
    };
    expect(Object.keys(facets.shards).every((id) => ids.has(id))).toBe(true);
  });

  it('v3 lists everything, with the credit fields intact', () => {
    const { index } = parseCatalogIndex(JSON.parse(credited.files.get('index.json') ?? ''));
    expect(index?.sources.find((s) => s.id === 'cartes-plein-air')?.freeAt).toBe(
      'cartespleinair.org',
    );
    expect(credited.itemCount).toBe(topoItems.length + cpa.items.length);
    const riverRows = [...credited.files]
      .filter(([path]) => path.startsWith('shards/river-'))
      .flatMap(([, body]) => (JSON.parse(body) as { items: CatalogItem[] }).items);
    expect(riverRows).toHaveLength(cpa.items.length);
    expect(riverRows.every((row) => row.author !== undefined && row.author !== '')).toBe(true);
  });

  it('v3 points at v2 for every identical shard and publishes only the rest', () => {
    const sharedRefs = credited.refs.filter((r) => r.path.startsWith('../v2/'));
    expect(sharedRefs.map((r) => r.id)).toEqual(legacy.refs.map((r) => r.id));
    expect(credited.sharedShardCount).toBe(legacy.refs.length);
    for (const ref of sharedRefs) {
      expect(ref.path).toBe(`../v2/shards/${ref.id}.json`);
      expect(credited.files.has(`shards/${ref.id}.json`)).toBe(false);
      expect(credited.shardBodies.get(ref.id)).toBe(legacy.shardBodies.get(ref.id));
    }
    const own = [...credited.files.keys()].filter((p) => p.startsWith('shards/'));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((p) => p.startsWith('shards/river-'))).toBe(true);
  });

  it('is deterministic: same fragments in, identical bytes out', () => {
    const again = buildBoth([...allItems].reverse(), NOW);
    expect([...again.legacy.files]).toEqual([...legacy.files]);
    expect([...again.credited.files]).toEqual([...credited.files]);
  });

  it('a later rebuild with nothing changed keeps both timestamps (no churn)', () => {
    const rebuilt = buildBoth(allItems, LATER, { legacy, credited });
    expect([...rebuilt.legacy.files]).toEqual([...legacy.files]);
    expect([...rebuilt.credited.files]).toEqual([...credited.files]);
  });

  it('a Cartes Plein-air-only change (the weekly crawl) touches v3 alone', () => {
    const withdrawn = cpa.items[0]?.id;
    const weekly = buildBoth(
      allItems.filter((item) => item.id !== withdrawn),
      LATER,
      { legacy, credited },
    );
    expect([...weekly.legacy.files]).toEqual([...legacy.files]);
    const v3Index = weekly.credited.files.get('index.json') ?? '';
    expect(v3Index).not.toBe(credited.files.get('index.json'));
    expect(v3Index).toContain(`"generatedAt": "${LATER}"`);
  });

  it('another source changing reaches both editions', () => {
    const extra: CatalogItem = { ...topoItems[0], id: 'cantopo-new' } as CatalogItem;
    const next = buildBoth([...allItems, extra], LATER, { legacy, credited });
    expect(next.legacy.files.get('index.json')).toContain(`"generatedAt": "${LATER}"`);
    expect(next.legacy.itemCount).toBe(topoItems.length + 1);
    expect(next.credited.itemCount).toBe(topoItems.length + 1 + cpa.items.length);
    // The changed topo shard is still shared, with its new size.
    const legacyRef = next.legacy.refs.find((r) => r.category === 'topo');
    const creditedRef = next.credited.refs.find((r) => r.id === legacyRef?.id);
    expect(creditedRef?.path).toBe(`../v2/shards/${legacyRef?.id}.json`);
    expect(creditedRef?.byteSize).toBe(legacyRef?.byteSize);
  });

  it('refuses rows whose source is not declared, and an empty catalog', () => {
    expect(() =>
      buildCatalogEdition({ sources: [], items: topoItems, collections: [], now: NOW }),
    ).toThrow(/undeclared sourceId/);
    expect(() =>
      buildCatalogEdition({ sources: [topoSource], items: [], collections: [], now: NOW }),
    ).toThrow(/zero shards/);
  });

  it('publishes collections when there are some', () => {
    const edition = buildCatalogEdition({
      sources: [topoSource],
      items: topoItems,
      collections: [
        { id: 'c', name: 'C', publisher: 'P', blurb: 'B', homepage: 'https://p.test/', places: [] },
      ],
      now: NOW,
    });
    expect(edition.files.has('collections.json')).toBe(true);
    expect(edition.files.get('index.json')).toContain('"collections"');
  });
});

describe('serializeWithStableTimestamp', () => {
  const render = (at: string) => `${JSON.stringify({ generatedAt: at, n: 1 })}\n`;

  it('keeps the previous timestamp when the rest is identical', () => {
    expect(serializeWithStableTimestamp(render, render('old'), 'new')).toBe(render('old'));
  });

  it('takes the new timestamp when the content changed', () => {
    const previous = `${JSON.stringify({ generatedAt: 'old', n: 2 })}\n`;
    expect(serializeWithStableTimestamp(render, previous, 'new')).toBe(render('new'));
  });

  it('takes the new timestamp with no, unparseable or timestamp-less previous output', () => {
    expect(serializeWithStableTimestamp(render, undefined, 'new')).toBe(render('new'));
    expect(serializeWithStableTimestamp(render, 'not json', 'new')).toBe(render('new'));
    expect(serializeWithStableTimestamp(render, '{"n":1}\n', 'new')).toBe(render('new'));
  });
});
