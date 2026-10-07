#!/usr/bin/env node
/**
 * Copy the shipped pdf.js files from the installed pdfjs-dist into
 * assets/pdfjs/ (see assets.mjs), and delete stale `.pdfjs` files there.
 *
 *   node scripts/pdfjs/sync-assets.mjs
 */
import { copyFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFJS_ASSETS, builtPdfjsVersion } from './assets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'node_modules/pdfjs-dist');
const out = join(root, 'assets/pdfjs');
const { version } = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));

for (const [asset, source] of Object.entries(PDFJS_ASSETS)) {
  copyFileSync(join(dist, source), join(out, asset));
}
for (const file of readdirSync(out)) {
  if (file.endsWith('.pdfjs') && !(file in PDFJS_ASSETS)) unlinkSync(join(out, file));
}
const built = builtPdfjsVersion(readFileSync(join(out, 'pdf.legacy.min.mjs.pdfjs'), 'utf8'));
console.log(`assets/pdfjs: pdfjs-dist ${version} (build header ${built})`);
