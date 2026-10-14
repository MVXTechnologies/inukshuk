import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseCatalogFacets } from './facets';
import { parseCatalogIndex, parseCatalogShard, type CatalogIndex } from './schema';
import { parseCatalogSearchDigest } from './searchDigest';

/**
 * Guards the catalog as COMMITTED under docs/catalog/ (what Pages serves),
 * not just the generator (#680). v2 is read by every installed app, including
 * those before 2.5.2 that cannot show the author credit and "Available free
 * at cartespleinair.org" the publisher's permission requires: not one
 * Cartes Plein-air byte may be in it. v3 is read by 2.5.2+ and must resolve
 * completely, its shared shards included.
 */

const CATALOG = join(__dirname, '../../../docs/catalog');
const V2 = join(CATALOG, 'v2');
const V3 = join(CATALOG, 'v3');

function readIndex(dir: string): CatalogIndex {
  const { index, warnings } = parseCatalogIndex(
    JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')),
  );
  expect(warnings).toEqual([]);
  if (index === null) throw new Error(`${dir}/index.json does not parse`);
  return index;
}

describe('published v2 (every installed app)', () => {
  const index = readIndex(V2);

  it('declares no source that needs credit rendering', () => {
    expect(index.sources.map((s) => s.id)).not.toContain('cartes-plein-air');
    expect(index.sources.filter((s) => s.freeAt !== undefined)).toEqual([]);
    expect(index.categoryCounts.river).toBeUndefined();
  });

  it('holds no Cartes Plein-air row, author or credit in any file', () => {
    const files = [
      ...readdirSync(V2).filter((f) => f.endsWith('.json')),
      ...readdirSync(join(V2, 'shards')).map((f) => `shards/${f}`),
    ];
    expect(files.length).toBeGreaterThan(300);
    const offending = files.filter((file) => {
      const body = readFileSync(join(V2, file), 'utf8');
      return (
        body.includes('cartes-plein-air') ||
        body.includes('cartespleinair') ||
        body.includes('"author"') ||
        body.includes('"freeAt"')
      );
    });
    expect(offending).toEqual([]);
  });

  it('lists exactly the shards on disk, and its digests name only those', () => {
    const onDisk = readdirSync(join(V2, 'shards'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    const ids = index.shards.map((s) => s.id).sort();
    expect(ids).toEqual(onDisk);
    expect(index.shards.every((s) => s.path === `shards/${s.id}.json`)).toBe(true);

    const { digest } = parseCatalogSearchDigest(
      JSON.parse(readFileSync(join(V2, 'search.json'), 'utf8')),
    );
    expect(digest?.shardIds.filter((id) => !ids.includes(id))).toEqual([]);
    const { facets } = parseCatalogFacets(
      JSON.parse(readFileSync(join(V2, 'facets.json'), 'utf8')),
    );
    expect(Object.keys(facets?.shards ?? {}).filter((id) => !ids.includes(id))).toEqual([]);
  });
});

describe('published v3 (2.5.2+)', () => {
  const index = readIndex(V3);
  const v2 = readIndex(V2);
  const sourceIds = new Set(index.sources.map((s) => s.id));

  it('is a superset of v2: every v2 source and shard, plus Cartes Plein-air', () => {
    for (const source of v2.sources) expect(index.sources).toContainEqual(source);
    expect(index.sources.find((s) => s.id === 'cartes-plein-air')?.freeAt).toBe(
      'cartespleinair.org',
    );
    const ids = new Set(index.shards.map((s) => s.id));
    expect(v2.shards.filter((s) => !ids.has(s.id))).toEqual([]);
  });

  it('every shard resolves to a file of the advertised size, shared ones inside v2', () => {
    const broken: string[] = [];
    for (const ref of index.shards) {
      const file = join(V3, ref.path);
      if (ref.path.startsWith('../') && !ref.path.startsWith('../v2/shards/')) {
        broken.push(`${ref.id}: shares outside v2 (${ref.path})`);
      } else if (!existsSync(file)) broken.push(`${ref.id}: missing ${ref.path}`);
      else if (statSync(file).size !== ref.byteSize) broken.push(`${ref.id}: size differs`);
    }
    expect(broken).toEqual([]);
  });

  it('its own shards are exactly the ones v2 cannot carry, every row credited', () => {
    const own = readdirSync(join(V3, 'shards')).sort();
    const ownRefs = index.shards.filter((s) => !s.path.startsWith('../'));
    expect(ownRefs.map((s) => `${s.id}.json`).sort()).toEqual(own);
    let rows = 0;
    for (const file of own) {
      const { items, warnings } = parseCatalogShard(
        JSON.parse(readFileSync(join(V3, 'shards', file), 'utf8')),
        sourceIds,
      );
      expect(warnings).toEqual([]);
      rows += items.length;
      for (const item of items) {
        expect(item.sourceId).toBe('cartes-plein-air');
        expect(item.author).toBeTruthy();
      }
    }
    expect(rows).toBe(index.categoryCounts.river);
  });
});
