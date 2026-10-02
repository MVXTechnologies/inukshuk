#!/usr/bin/env node
/**
 * A gentle probe of the live contour tiles (../README.md, "The free plan's
 * CPU limit"): asks for a square of tiles around a point and tallies what
 * came back — `generated`, `partial`, `r2`, edge-cached, or an error (503
 * "error code: 1102" is the Worker's CPU limit).
 *
 *   node infra/tiles/probe-contours.mjs <lat> <lon> <zoom> [tiles=36] [concurrency=12] [offset=0]
 *   node infra/tiles/probe-contours.mjs 51.05 -67.1 13 36 12 80
 *
 * Tiles already generated answer `r2` (or from the edge) and prove nothing:
 * move the square with `offset` (in tiles, east and south) to probe uncached
 * ones. At most 60 requests a run, and only a few runs: the free plan's
 * 100 000 requests a day are shared with the app's users.
 *
 * HOST overrides the Worker (e.g. HOST=http://127.0.0.1:8787 for `wrangler
 * dev`); VERBOSE=1 lists every tile.
 */
const HOST = process.env.HOST ?? 'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev';
const [lat, lon, z] = process.argv.slice(2, 5).map(Number);
if (![lat, lon, z].every(Number.isFinite)) {
  console.error(
    'usage: probe-contours.mjs <lat> <lon> <zoom> [tiles=36] [concurrency=12] [offset=0]',
  );
  process.exit(2);
}
const count = Math.min(60, Number(process.argv[5] ?? 36));
const concurrency = Number(process.argv[6] ?? 12);
const offset = Number(process.argv[7] ?? 0);

const n = 2 ** z;
const x0 = Math.floor(((lon + 180) / 360) * n) + offset;
const rad = (lat * Math.PI) / 180;
const y0 =
  Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n) + offset;
const side = Math.ceil(Math.sqrt(count));
const tiles = Array.from({ length: count }, (_, i) => [x0 + (i % side), y0 + Math.floor(i / side)]);

const tally = {};
const lines = [];
async function probe([x, y]) {
  const started = Date.now();
  let outcome;
  try {
    const res = await fetch(`${HOST}/contours/${z}/${x}/${y}.mvt?v=2`);
    if (res.status === 200) {
      await res.arrayBuffer();
      outcome = `200 ${res.headers.get('x-contour-source') ?? 'cached'}`;
    } else {
      outcome = `${res.status} ${(await res.text()).slice(0, 40)}`;
    }
  } catch (e) {
    outcome = `failed ${String(e).slice(0, 60)}`;
  }
  tally[outcome] = (tally[outcome] ?? 0) + 1;
  lines.push(`${z}/${x}/${y}  ${outcome}  ${Date.now() - started} ms`);
}

let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < tiles.length) await probe(tiles[next++]);
  }),
);
if (process.env.VERBOSE) console.log(lines.join('\n'));
const failed = Object.entries(tally)
  .filter(([outcome]) => !outcome.startsWith('200'))
  .reduce((sum, [, v]) => sum + v, 0);
console.log(`${count} tiles from ${z}/${x0}/${y0} at concurrency ${concurrency}:`, tally);
console.log(`failed ${failed}/${count}`);
process.exit(failed > 0 ? 1 : 0);
