#!/usr/bin/env node
/**
 * Copy the shipped pdf.js files from the installed pdfjs-dist into
 * assets/pdfjs/ (see assets.mjs), regenerate the derived ones (needs wabt),
 * and delete stale `.pdfjs` files there.
 *
 *   node scripts/pdfjs/sync-assets.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFJS_ASSETS, PDFJS_DERIVED_ASSETS, builtPdfjsVersion } from './assets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'node_modules/pdfjs-dist');
const out = join(root, 'assets/pdfjs');
const { version } = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));

for (const [asset, source] of Object.entries(PDFJS_ASSETS)) {
  copyFileSync(join(dist, source), join(out, asset));
}
// Derived files (assets.mjs PDFJS_DERIVED_ASSETS) are regenerated from the
// fresh copies; their pinned hashes in assets.mjs must then be updated.
for (const derived of Object.values(PDFJS_DERIVED_ASSETS)) {
  execFileSync(process.execPath, [join(root, derived.script)], { stdio: 'inherit' });
}
for (const file of readdirSync(out)) {
  if (file.endsWith('.pdfjs') && !(file in PDFJS_ASSETS)) unlinkSync(join(out, file));
}
const built = builtPdfjsVersion(readFileSync(join(out, 'pdf.legacy.min.mjs.pdfjs'), 'utf8'));
console.log(`assets/pdfjs: pdfjs-dist ${version} (build header ${built})`);
