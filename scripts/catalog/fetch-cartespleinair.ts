/**
 * Catalog generator — Cartes Plein-air canoe maps (#680).
 *
 * Crawls https://cartespleinair.org/cartes, the only index the site has (no
 * feed, and map URLs cannot be guessed), and writes the catalog fragment.
 * Used with the publisher's written permission of 2026-10-13; the terms are in
 * docs/CATALOG-SOURCES.md §1.6 and bind this script:
 *
 * - **Link, never copy.** It never downloads a map: one HEAD per new PDF for
 *   its size and ETag, nothing else. The phone downloads from the publisher.
 * - **Polite.** User-Agent `InukshukCatalogBot/1.0`, robots.txt obeyed on every
 *   host, at most one request per second per host, conditional requests.
 *   (`@core/catalog/cartesPleinAir/politeClient`, unit-tested.)
 *
 * What a crawl does and how it decides is `@core/catalog/cartesPleinAir/crawl`;
 * this file is only its I/O.
 *
 * Usage:
 *   npx tsx scripts/catalog/fetch-cartespleinair.ts [--summary <file>] [--limit N]
 *   npx tsx scripts/catalog/build-manifest.ts
 *
 * Writes, only when something changed:
 * - scripts/catalog/fragments/cartes-plein-air.json — the catalog rows;
 * - scripts/catalog/sources/cartespleinair-rivers.json — the river gazetteer
 *   (each river's CGNDB match, reviewed in the pull request).
 * `--summary` writes the change summary (Markdown) for the weekly PR.
 * `--limit N` crawls N maps to try the crawler out; it never writes.
 *
 * Exit status: 0 with or without changes; 1 when the crawl failed or was
 * refused (e.g. it would withdraw more than a fifth of the maps at once).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crawlCartesPleinAir,
  type Gazetteer,
  type ListingCache,
} from '../../src/core/catalog/cartesPleinAir/crawl';
import { diffIsEmpty, diffSummaryMarkdown } from '../../src/core/catalog/cartesPleinAir/diff';
import { CPA_SOURCE } from '../../src/core/catalog/cartesPleinAir/items';
import { PoliteClient } from '../../src/core/catalog/cartesPleinAir/politeClient';
import { parseCatalogShard, type CatalogItem } from '../../src/core/catalog/schema';
import { sleep } from './http';

const CRAWLER_USER_AGENT = 'InukshukCatalogBot/1.0 (+https://inukshuk.mvxtechnologies.com)';

/** One request per second per host, with a little margin. */
const MIN_INTERVAL_MS = 1100;

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fragmentPath = join(scriptDir, 'fragments', 'cartes-plein-air.json');
  const gazetteerPath = join(scriptDir, 'sources', 'cartespleinair-rivers.json');
  const cachePath = join(scriptDir, '.cache', 'cartespleinair-listing.json');
  const summaryPath = argValue('--summary');
  const limitArg = argValue('--limit');
  const limit = limitArg !== undefined ? Number(limitArg) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('--limit takes a positive whole number');
  }

  const fragment = readJson<{ items?: unknown[] }>(fragmentPath, { items: [] });
  const { items: previous, warnings: previousWarnings } = parseCatalogShard(
    fragment.items ?? [],
    new Set([CPA_SOURCE.id]),
  );
  if (previousWarnings.length > 0) {
    throw new Error(`${fragmentPath} failed validation:\n  ${previousWarnings.join('\n  ')}`);
  }
  const gazetteerDoc = readJson<{ rivers?: Gazetteer }>(gazetteerPath, {});
  const listingCache = readJson<ListingCache | undefined>(cachePath, undefined);

  const client = new PoliteClient({
    userAgent: CRAWLER_USER_AGENT,
    productToken: 'InukshukCatalogBot',
    minIntervalMs: MIN_INTERVAL_MS,
    fetch: (url, init) => fetch(url, init),
    sleep,
    now: () => Date.now(),
    log: (message) => console.warn(`  ${message}`),
  });

  const started = Date.now();
  const result = await crawlCartesPleinAir({
    client,
    previous,
    gazetteer: gazetteerDoc.rivers ?? {},
    today: new Date().toISOString().slice(0, 10),
    ...(listingCache !== undefined ? { listingCache } : {}),
    ...(limit !== undefined ? { limit } : {}),
    log: (message) => console.warn(`  ${message}`),
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`requests per host: ${JSON.stringify(client.requestCounts())} in ${seconds} s`);

  const summary = diffSummaryMarkdown(result.diff, result.items.length);
  console.log(summary);
  if (result.refused !== null) {
    console.error(`not written: ${result.refused}`);
    process.exitCode = limit !== undefined ? 0 : 1;
    return;
  }
  if (result.listingCache !== undefined) writeJson(cachePath, result.listingCache);

  const gazetteerChanged =
    JSON.stringify(result.gazetteer) !== JSON.stringify(gazetteerDoc.rivers ?? {});
  if (diffIsEmpty(result.diff) && !gazetteerChanged && existsSync(fragmentPath)) {
    console.log('no changes');
    return;
  }

  // Every row must survive the app's own parser before it is written.
  const items: CatalogItem[] = result.items;
  const check = parseCatalogShard(JSON.parse(JSON.stringify(items)), new Set([CPA_SOURCE.id]));
  if (check.warnings.length > 0 || check.items.length !== items.length) {
    throw new Error(`crawl output failed validation:\n  ${check.warnings.join('\n  ')}`);
  }
  writeJson(fragmentPath, {
    _comment:
      'Generated by scripts/catalog/fetch-cartespleinair.ts from https://cartespleinair.org/cartes, with the publisher’s written permission (docs/CATALOG-SOURCES.md §1.6). Links only: no map is copied.',
    sources: [CPA_SOURCE],
    items,
  });
  const rivers = Object.fromEntries(
    Object.entries(result.gazetteer).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeJson(gazetteerPath, {
    _comment:
      'River locations for the Cartes Plein-air maps, by the site’s river id: each river’s single matching feature in the Canadian Geographical Names Database (NRCan, OGL-Canada 2.0), or no `match` when none or several matched (the map is then located by region). Written by fetch-cartespleinair.ts; edit a `match` by hand to correct it.',
    rivers,
  });
  if (summaryPath !== undefined) {
    const warnings =
      result.warnings.length === 0
        ? ''
        : `\n\n### Warnings\n\n${result.warnings.map((w) => `- ${w}`).join('\n')}`;
    writeFileSync(summaryPath, `${summary}${warnings}\n`);
  }
  console.log(`wrote ${fragmentPath} (${items.length} maps) and ${gazetteerPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
