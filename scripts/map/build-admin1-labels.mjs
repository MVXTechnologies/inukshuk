/**
 * Regenerates `docs/data/admin1-labels-v1.json` — the worldwide province /
 * state label points the stone base map draws (see `admin1Labels.mjs`) —
 * from Natural Earth's 1:10m admin-1 layer (public domain), the same file
 * `infra/tiles/nas/trails.sh` downloads.
 *
 * The output is a static file on the GitHub Pages site: MapLibre fetches it
 * as a GeoJSON source, caches it with the tiles, and stores it in offline
 * packs. No NAS run, no Worker deploy — merge to main and Pages serves it.
 *
 * Usage (network required unless a local copy is given):
 *   node scripts/map/build-admin1-labels.mjs [path/to/ne_10m_admin_1_states_provinces.geojson]
 *
 * The file name is versioned: a change to the PROPERTIES the style reads
 * needs a new name (and the app pointed at it); a data refresh does not.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAdmin1Labels, serializeAdmin1Labels } from './admin1Labels.mjs';

const NE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'data',
  'admin1-labels-v1.json',
);

async function load(path) {
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  const res = await fetch(NE_URL);
  if (!res.ok) throw new Error(`Natural Earth: HTTP ${res.status}`);
  return res.json();
}

const collection = buildAdmin1Labels(await load(process.argv[2]));
const text = serializeAdmin1Labels(collection);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
const regions = collection.features.filter((f) => f.properties.u !== undefined).length;
console.log(
  `${OUT}: ${collection.features.length} points (${regions} grouped regions), ${(text.length / 1024).toFixed(0)} KB`,
);
