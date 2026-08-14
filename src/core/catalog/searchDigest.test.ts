import { matchesCatalogFilter } from './filterCatalog';
import type { CatalogItem } from './schema';
import {
  buildCatalogSearchDigest,
  CATALOG_SEARCH_SCHEMA_VERSION,
  digestTerms,
  parseCatalogSearchDigest,
  shardIdsForQuery,
  type DigestShardInput,
} from './searchDigest';

function item(id: string, title: string, region?: string): CatalogItem {
  return {
    id,
    sourceId: 'src',
    title,
    category: 'topo',
    format: 'geopdf',
    packaging: 'none',
    url: `https://example.test/${id}.pdf`,
    ...(region !== undefined ? { region } : {}),
  };
}

const shards: DigestShardInput[] = [
  {
    id: 'topo-n40w080',
    items: [
      item('cantopo-021l14', 'Québec — CanTopo 021L14', 'CA-QC'),
      item('cantopo-021l13', 'Saint-Raymond — CanTopo 021L13', 'CA-QC'),
    ],
  },
  {
    id: 'topo-n30w120',
    items: [item('usgs-36112a1', 'Grand Canyon — US Topo 7.5′', 'US-AZ')],
  },
  {
    id: 'topo-s40e140',
    items: [item('austopo-sh54-11', 'Cobham Lake SH54-11 — AUSTopo 250k', 'AU')],
  },
];

const digest = buildCatalogSearchDigest(shards);

describe('digestTerms', () => {
  it('folds diacritics and splits on non-alphanumerics', () => {
    expect(digestTerms('Québec — CanTopo 021L14')).toEqual(['quebec', 'cantopo', '021l14']);
  });

  it('drops runs too short to constrain anything', () => {
    expect(digestTerms('a b St')).toEqual(['st']);
    expect(digestTerms('   ')).toEqual([]);
  });
});

describe('buildCatalogSearchDigest', () => {
  it('indexes title, id and region across the shards that hold them', () => {
    expect(digest.shardIds).toEqual(['topo-n40w080', 'topo-n30w120', 'topo-s40e140']);
    expect(digest.tokens.canyon).toEqual([1]);
    expect(digest.tokens.quebec).toEqual([0]);
    // "cantopo" appears in both Québec sheets — one shard, listed once.
    expect(digest.tokens.cantopo).toEqual([0]);
  });

  it('is deterministic — same catalog in, byte-identical digest out', () => {
    for (const postings of Object.values(digest.tokens)) {
      expect(postings).toEqual([...postings].sort((a, b) => a - b));
    }
    expect(JSON.stringify(buildCatalogSearchDigest(shards))).toBe(JSON.stringify(digest));
    // Item order inside a shard must not move a byte either.
    const reordered = shards.map((s) => ({ id: s.id, items: [...s.items].reverse() }));
    expect(JSON.stringify(buildCatalogSearchDigest(reordered))).toBe(JSON.stringify(digest));
  });
});

describe('shardIdsForQuery', () => {
  it('finds the far shard a nearest-first fetch would never have pulled', () => {
    expect(shardIdsForQuery(digest, 'Grand Canyon')).toEqual(['topo-n30w120']);
  });

  it('matches diacritic-folded, like the item filter', () => {
    expect(shardIdsForQuery(digest, 'quebec')).toEqual(['topo-n40w080']);
    expect(shardIdsForQuery(digest, 'Québec')).toEqual(['topo-n40w080']);
  });

  it('matches a partial token, like the item filter', () => {
    expect(shardIdsForQuery(digest, 'cany')).toEqual(['topo-n30w120']);
    expect(shardIdsForQuery(digest, '021l1')).toEqual(['topo-n40w080']);
  });

  it('splits a hyphenated query on the haystack’s own boundaries', () => {
    // The item filter matches "saint-raymond" against the whole haystack; the
    // digest holds "saint" and "raymond" separately, so it must split too.
    expect(shardIdsForQuery(digest, 'saint-raymond')).toEqual(['topo-n40w080']);
  });

  it('requires every term, so unrelated words select nothing', () => {
    expect(shardIdsForQuery(digest, 'grand quebec')).toEqual([]);
  });

  // The whole point: an empty ARRAY is a real "the catalog has none of these",
  // which is what finally makes "No maps match your search." a true statement.
  it('answers "genuinely nothing" for a word no shard holds', () => {
    expect(shardIdsForQuery(digest, 'kilimanjaro')).toEqual([]);
  });

  it('returns null when the query cannot constrain anything', () => {
    expect(shardIdsForQuery(digest, '')).toBeNull();
    expect(shardIdsForQuery(digest, '   ')).toBeNull();
    expect(shardIdsForQuery(digest, 'q')).toBeNull();
  });

  // The safety property the empty state relies on: the digest is never
  // narrower than the filter that runs on the fetched items.
  it('never excludes a shard whose items the item filter would match', () => {
    const queries = [
      'grand',
      'canyon',
      'grand canyon',
      'saint-raymond',
      'raymond',
      'cantopo 021',
      'lake',
      'sh54',
      'austopo 250k',
      'ca-qc',
      'us-az',
      'topo',
      '7.5',
      'québec',
    ];
    for (const query of queries) {
      const selected = shardIdsForQuery(digest, query);
      for (const shard of shards) {
        const anyMatch = shard.items.some((i) => matchesCatalogFilter(i, { text: query }));
        if (!anyMatch) continue;
        // null means "no usable constraint" — the caller fetches broadly, so
        // nothing is excluded; otherwise the shard must be in the selection.
        if (selected !== null) expect(selected).toContain(shard.id);
      }
    }
  });
});

describe('parseCatalogSearchDigest', () => {
  it('round-trips a generated digest', () => {
    const { digest: parsed, warnings } = parseCatalogSearchDigest(
      JSON.parse(JSON.stringify(digest)),
    );
    expect(warnings).toEqual([]);
    expect(parsed).toEqual(digest);
  });

  it('rejects documents it cannot use', () => {
    expect(parseCatalogSearchDigest(null).digest).toBeNull();
    expect(parseCatalogSearchDigest([]).digest).toBeNull();
    expect(parseCatalogSearchDigest({ schemaVersion: 99 }).digest).toBeNull();
    expect(
      parseCatalogSearchDigest({ schemaVersion: CATALOG_SEARCH_SCHEMA_VERSION, tokens: {} }).digest,
    ).toBeNull();
    expect(
      parseCatalogSearchDigest({ schemaVersion: CATALOG_SEARCH_SCHEMA_VERSION, shardIds: ['a'] })
        .digest,
    ).toBeNull();
  });

  it('drops malformed postings instead of blanking search', () => {
    const { digest: parsed, warnings } = parseCatalogSearchDigest({
      schemaVersion: CATALOG_SEARCH_SCHEMA_VERSION,
      shardIds: ['a', 'b'],
      tokens: { good: [0, 1], bad: 'nope', partly: [1, 99], gone: [42] },
    });
    expect(parsed?.tokens).toEqual({ good: [0, 1], partly: [1] });
    expect(warnings).toHaveLength(3);
    expect(shardIdsForQuery(parsed ?? digest, 'good')).toEqual(['a', 'b']);
  });
});
