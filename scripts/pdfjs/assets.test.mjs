/**
 * The pdf.js the app ships (assets/pdfjs/) is the installed, locked
 * pdfjs-dist, and it is not a release affected by GHSA-wgrm-67xf-hhpq
 * (CVE-2024-4367). CI runs this after `npm ci`; the nightly audit covers the
 * npm side of the same advisory.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PDFJS_ASSETS,
  PDFJS_FIRST_PATCHED,
  builtPdfjsVersion,
  compareVersions,
} from './assets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (...p) => readFileSync(join(root, ...p));
const lock = JSON.parse(read('package-lock.json').toString());
const lockedVersion = lock.packages['node_modules/pdfjs-dist'].version;

test('compareVersions orders x.y.z numerically', () => {
  assert.ok(compareVersions('4.2.67', '4.1.392') > 0);
  assert.ok(compareVersions('4.10.38', '4.2.67') > 0);
  assert.ok(compareVersions('3.11.174', '4.2.67') < 0);
  assert.equal(compareVersions('6.4.299', '6.4.299'), 0);
});

test('the shipped pdf.js is a patched release (GHSA-wgrm-67xf-hhpq)', () => {
  for (const asset of ['pdf.legacy.min.mjs.pdfjs', 'pdf.worker.legacy.min.mjs.pdfjs']) {
    const version = builtPdfjsVersion(read('assets/pdfjs', asset).toString('utf8'));
    assert.ok(version, `${asset}: no pdfjsVersion header`);
    assert.ok(
      compareVersions(version, PDFJS_FIRST_PATCHED) >= 0,
      `${asset} is pdf.js ${version}; ${PDFJS_FIRST_PATCHED} or later is required`,
    );
    assert.equal(version, lockedVersion, `${asset} is not the locked pdfjs-dist`);
  }
  assert.ok(compareVersions(lockedVersion, PDFJS_FIRST_PATCHED) >= 0);
});

test('every shipped pdf.js file is byte-identical to the installed pdfjs-dist', () => {
  const installed = JSON.parse(read('node_modules/pdfjs-dist/package.json').toString()).version;
  assert.equal(installed, lockedVersion, 'node_modules is not the locked pdfjs-dist');
  for (const [asset, source] of Object.entries(PDFJS_ASSETS)) {
    assert.ok(
      read('assets/pdfjs', asset).equals(read('node_modules/pdfjs-dist', source)),
      `assets/pdfjs/${asset} differs from pdfjs-dist/${source}: run node scripts/pdfjs/sync-assets.mjs`,
    );
  }
  const shipped = readdirSync(join(root, 'assets/pdfjs')).filter((f) => f.endsWith('.pdfjs'));
  assert.deepEqual(shipped.sort(), Object.keys(PDFJS_ASSETS).sort());
});

test('no shipped pdf.js file can compile JavaScript from a string', () => {
  // The advisory's sink was `new Function` over font data; 6.x has no eval
  // path at all. A future build that brings one back must be reviewed.
  for (const asset of Object.keys(PDFJS_ASSETS).filter((a) => !a.includes('.wasm.'))) {
    const source = read('assets/pdfjs', asset).toString('utf8');
    assert.doesNotMatch(source, /new Function\s*\(|\beval\s*\(/, asset);
  }
});
