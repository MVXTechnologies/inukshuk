/**
 * Catalog generator — Québec river-descent maps (source list `quebec-rivers`).
 *
 * Hand-curated and permission-gated, not crawled. No publisher of
 * river-descent maps exposes an index, and none checked on 2026-10-02 licenses
 * its files (docs/research/quebec-river-maps.md). The reviewed list lives in
 * `scripts/catalog/sources/quebec-rivers.json`:
 *
 * - every publisher carries a `permission` block (`granted` | `pending`, with
 *   evidence);
 * - only maps from `granted` publishers reach the fragment;
 * - `@core/catalog/riverMaps` validates all of it.
 *
 * This script only HEADs each publishable URL for its real size and date. It
 * never downloads or rehosts a map: the phone fetches the file from the
 * publisher, like every other catalog source. A URL that does not answer 200
 * with a PDF is left out (and reported), so a moved or withdrawn map can never
 * ship as a dead row.
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-quebec-rivers.ts
 *   npx tsx scripts/catalog/build-manifest.ts
 *
 * Output: scripts/catalog/fragments/quebec-rivers.json. While no publisher has
 * granted permission, no fragment is written (and a stale one is removed),
 * so the published catalog is untouched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  lastModifiedDate,
  parseRiverMapList,
  publishableRiverMaps,
  riverMapItem,
  riverMapSources,
  type RiverMapHead,
} from '../../src/core/catalog/riverMaps';
import { mapPool, politeFetch } from './http';

/** A handful of small publisher sites: two requests in flight is plenty. */
const HEAD_CONCURRENCY = 2;

async function headMap(url: string): Promise<RiverMapHead | null> {
  // `identity`: Apache (COBARIC) drops Content-Length from a HEAD that offers
  // gzip, because the length of a compressed body is not known in advance.
  const res = await politeFetch(url, {
    method: 'HEAD',
    headers: { 'Accept-Encoding': 'identity' },
  });
  if (res === null || res.status !== 200) {
    console.warn(`  ${url} → ${res?.status ?? 'network error'}; left out`);
    return null;
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/pdf|octet-stream/i.test(type)) {
    console.warn(`  ${url} answered ${type || 'no content-type'}, not a PDF; left out`);
    return null;
  }
  const length = Number(res.headers.get('content-length'));
  const updatedAt = lastModifiedDate(res.headers.get('last-modified'));
  return {
    ...(Number.isFinite(length) && length > 0 ? { sizeBytes: length } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const listPath = join(scriptDir, 'sources', 'quebec-rivers.json');
  const outPath = join(scriptDir, 'fragments', 'quebec-rivers.json');

  const { list, warnings } = parseRiverMapList(JSON.parse(readFileSync(listPath, 'utf8')));
  if (warnings.length > 0) {
    throw new Error(`${listPath} failed validation:\n  ${warnings.join('\n  ')}`);
  }
  const { maps, pending } = publishableRiverMaps(list);
  console.log(
    `${list.publishers.length} publishers, ${list.maps.length} maps curated: ` +
      `${maps.length} publishable, ${pending} waiting for permission`,
  );

  if (maps.length === 0) {
    if (existsSync(outPath)) rmSync(outPath);
    console.log('no publisher has granted permission yet: no fragment written');
    return;
  }

  const heads = await mapPool(maps, HEAD_CONCURRENCY, (entry) => headMap(entry.url));
  const items = maps.flatMap((entry, i) => {
    const head = heads[i];
    return head === null || head === undefined ? [] : [riverMapItem(entry, head)];
  });

  // Declare only publishers that still have a live map, so the index never
  // lists a source with nothing behind it.
  const sources = riverMapSources(list, new Set(items.map((item) => item.sourceId)));

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ sources, items }, null, 2)}\n`);
  console.log(
    `wrote ${outPath} (${sources.length} sources, ${items.length} of ${maps.length} maps)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
