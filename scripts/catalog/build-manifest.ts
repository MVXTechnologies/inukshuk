/**
 * Catalog generator — merge per-source fragments into the published manifest.
 *
 * Reads every `scripts/catalog/fragments/*.json` (written by the
 * fetch-<source>.ts crawlers, or hand-curated), merges sources + items,
 * validates the result with the SAME parser the app ships
 * (`src/core/catalog/schema`) and refuses to write anything that parser would
 * warn about — the generator and the client cannot drift.
 *
 * Usage:
 *   npx tsx scripts/catalog/build-manifest.ts
 *
 * Output: docs/catalog/v1/manifest.json (the Pages site serves docs/ as its
 * root, so this publishes at /catalog/v1/manifest.json once pushed).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_SCHEMA_VERSION,
  parseCatalogManifest,
  type CatalogItem,
  type CatalogSource,
} from '../../src/core/catalog/schema';

interface Fragment {
  sources?: CatalogSource[];
  items?: CatalogItem[];
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fragmentsDir = join(scriptDir, 'fragments');
  const outPath = join(scriptDir, '..', '..', 'docs', 'catalog', 'v1', 'manifest.json');

  const fragmentFiles = readdirSync(fragmentsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (fragmentFiles.length === 0) {
    throw new Error(`no fragments in ${fragmentsDir} — run a fetch-<source>.ts first`);
  }

  const sources: CatalogSource[] = [];
  const items: CatalogItem[] = [];
  for (const file of fragmentFiles) {
    const fragment = JSON.parse(readFileSync(join(fragmentsDir, file), 'utf8')) as Fragment;
    sources.push(...(fragment.sources ?? []));
    items.push(...(fragment.items ?? []));
    console.log(
      `${file}: ${fragment.sources?.length ?? 0} sources, ${fragment.items?.length ?? 0} items`,
    );
  }
  items.sort((a, b) => a.id.localeCompare(b.id));

  const manifest = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sources,
    items,
  };

  // The app's own parser is the gate: anything it would drop fails the build.
  const { manifest: parsed, warnings } = parseCatalogManifest(manifest);
  if (parsed === null || warnings.length > 0) {
    throw new Error(`manifest failed validation:\n  ${warnings.join('\n  ')}`);
  }
  if (parsed.items.length === 0) {
    throw new Error('manifest has zero items — refusing to publish an empty store');
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${outPath} (${parsed.items.length} items, ${parsed.sources.length} sources)`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
