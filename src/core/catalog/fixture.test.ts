import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGeoPdf } from '../geo/geopdf';
import { nearbyCatalogItems } from './nearby';
import { parseCatalogIndex, parseCatalogShard, type CatalogItem } from './schema';
import { parseCatalogSearchDigest, shardIdsForQuery } from './searchDigest';
import { resolveCatalogUrl, selectShards } from './shard';
import { extractPdf } from './unzip';

/**
 * Guards the CHECKED-IN e2e fixture (`.maestro/fixtures/catalog/`, generated
 * by scripts/catalog/make-fixture.ts): the Maestro store flow and the CI
 * fixture server depend on these exact files, so a fixture that stops parsing
 * must fail unit tests long before a nightly e2e run discovers it.
 *
 * The fixture is sharded on purpose — it is the only place the index → shard
 * fetch and the cross-category "Around you" section are exercised end to end.
 */

const FIXTURE_DIR = join(__dirname, '..', '..', '..', '.maestro', 'fixtures', 'catalog');
const FIXTURE_INDEX_URL = 'http://127.0.0.1:8787/index.json';

const indexRaw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'index.json'), 'utf8'));
const { index, warnings: indexWarnings } = parseCatalogIndex(indexRaw);
const sourceIds = new Set((index?.sources ?? []).map((s) => s.id));

/** Every item across every fixture shard, read the way the app would. */
function allItems(): CatalogItem[] {
  const items: CatalogItem[] = [];
  for (const shard of index?.shards ?? []) {
    const url = resolveCatalogUrl(FIXTURE_INDEX_URL, shard.path);
    expect(url).not.toBeNull();
    const file = join(FIXTURE_DIR, shard.path);
    const parsed = parseCatalogShard(JSON.parse(readFileSync(file, 'utf8')), sourceIds);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items).toHaveLength(shard.itemCount);
    items.push(...parsed.items);
  }
  return items;
}

describe('checked-in e2e fixture catalog', () => {
  it('parses clean through the app index parser', () => {
    expect(indexWarnings).toEqual([]);
    expect(index).not.toBeNull();
    expect(index?.shards.length).toBeGreaterThanOrEqual(2);
    // The landing grid reads these, not the items — they must be right.
    expect(index?.categoryCounts).toEqual({ topo: 3, nautical: 2 });
  });

  it('ships every shard the index advertises, and no orphans', () => {
    const onDisk = readdirSync(join(FIXTURE_DIR, 'shards')).sort();
    const advertised = (index?.shards ?? []).map((s) => `${s.id}.json`).sort();
    expect(onDisk).toEqual(advertised);
  });

  it('holds the exact rows the store flow asserts on', () => {
    const titles = allItems().map((i) => i.title);
    // The flow types "raymond" and expects exactly one topo row to survive.
    expect(titles).toContain('Québec — CanTopo 021L14');
    expect(titles).toContain('Saint-Raymond — CanTopo 021L13');
    // …and a nautical row, so the Nautical category card and the mixed
    // "Around you" section both have something real behind them.
    expect(titles).toContain('Chart 14771 — Fixture Harbour');
  });

  it('points only at the loopback fixture server', () => {
    // A fixture pointing at the real internet would let CI silently depend on
    // NRCan or NOAA being up.
    for (const item of allItems()) {
      expect(item.url.startsWith('http://127.0.0.1:8787/')).toBe(true);
    }
    for (const shard of index?.shards ?? []) {
      expect(resolveCatalogUrl(FIXTURE_INDEX_URL, shard.path)).toMatch(
        /^http:\/\/127\.0\.0\.1:8787\//,
      );
    }
  });

  it('puts both categories within reach of the emulator’s geo fix', () => {
    // CI runs `adb emu geo fix -71.2082 46.8139` and the flow re-sets the same
    // point; the landing must therefore select both shards and show a mix.
    const emulator = { latitude: 46.8139, longitude: -71.2082 };
    const picked = selectShards(index?.shards ?? [], emulator, { limit: 6 });
    expect(picked.map((s) => s.category).sort()).toEqual(['nautical', 'topo']);

    // Exactly NEARBY_ROWS rows, from BOTH categories. The count is the point:
    // the fixture holds five items so the section is full only when the
    // per-category cap adapts (3 topo + 2 nautical). With the fixed cap of 2
    // that shipped, this is 4 — which is the regression that reached users as
    // a two-row "Around you" in the single-category production catalog.
    const nearby = nearbyCatalogItems(allItems(), emulator, { limit: 5 });
    expect(nearby).toHaveLength(5);
    expect(new Set(nearby.map((n) => n.item.category)).size).toBe(2);
  });

  it('ships a search digest that reaches items no nearby fetch would', () => {
    const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'search.json'), 'utf8'));
    const { digest, warnings } = parseCatalogSearchDigest(raw);
    expect(warnings).toEqual([]);
    if (digest === null) throw new Error('fixture search digest did not parse');
    expect(index?.search?.path).toBe('search.json');

    // The flow's search term selects the shard holding Saint-Raymond…
    expect(shardIdsForQuery(digest, 'raymond')).toEqual(['topo-n40w080']);
    // …and a term the fixture genuinely lacks selects nothing, which is what
    // lets the screen say "No maps match your search." truthfully.
    expect(shardIdsForQuery(digest, 'kilimanjaro')).toEqual([]);
  });

  it('ships zips whose PDFs our importer can georeference', () => {
    for (const item of allItems()) {
      const fileName = item.url.split('/').pop() ?? '';
      const zip = readFileSync(join(FIXTURE_DIR, fileName));
      expect(zip.byteLength).toBe(item.sizeBytes); // manifest sizes are real
      const pdf = extractPdf(new Uint8Array(zip));
      expect(pdf).not.toBeNull();
      const parsed = parseGeoPdf(pdf ?? new Uint8Array());
      expect(parsed.georeferences).toHaveLength(1);
    }
  });
});
