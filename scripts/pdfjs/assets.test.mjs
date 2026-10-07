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
import { createHash } from 'node:crypto';
import {
  PDFJS_ASSETS,
  PDFJS_DERIVED_ASSETS,
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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('every shipped pdf.js file is the installed pdfjs-dist (or pinned derived from it)', () => {
  const installed = JSON.parse(read('node_modules/pdfjs-dist/package.json').toString()).version;
  assert.equal(installed, lockedVersion, 'node_modules is not the locked pdfjs-dist');
  for (const [asset, source] of Object.entries(PDFJS_ASSETS)) {
    const derived = PDFJS_DERIVED_ASSETS[asset];
    if (derived) {
      assert.equal(
        sha256(read('node_modules/pdfjs-dist', source)),
        derived.sourceSha256,
        `pdfjs-dist/${source} changed: regenerate ${asset} (${derived.script}) and re-pin`,
      );
      assert.equal(
        sha256(read('assets/pdfjs', asset)),
        derived.sha256,
        `${asset} is not the pinned result`,
      );
      continue;
    }
    assert.ok(
      read('assets/pdfjs', asset).equals(read('node_modules/pdfjs-dist', source)),
      `assets/pdfjs/${asset} differs from pdfjs-dist/${source}: run node scripts/pdfjs/sync-assets.mjs`,
    );
  }
  const shipped = readdirSync(join(root, 'assets/pdfjs')).filter((f) => f.endsWith('.pdfjs'));
  assert.deepEqual(shipped.sort(), Object.keys(PDFJS_ASSETS).sort());
});

test('the shipped JPEG 2000 decoder uses no relaxed SIMD (iOS cannot compile it)', () => {
  // Relaxed SIMD opcodes are 0xFD-prefixed 0x100-0x113, LEB128-encoded as
  // FD (80-93) 02. The rewritten decoder has none; the upstream one has 14.
  const count = (bytes) => {
    let n = 0;
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (
        bytes[i] === 0xfd &&
        bytes[i + 1] >= 0x80 &&
        bytes[i + 1] <= 0x93 &&
        bytes[i + 2] === 0x02
      )
        n++;
    }
    return n;
  };
  assert.ok(count(read('node_modules/pdfjs-dist/wasm/openjpeg.wasm')) >= 14);
  assert.equal(count(read('assets/pdfjs/openjpeg.wasm.pdfjs')), 0);
});

test('no shipped pdf.js file can compile JavaScript from a string', () => {
  // The advisory's sink was `new Function` over font data; 6.x has no eval
  // path at all. A future build that brings one back must be reviewed.
  for (const asset of Object.keys(PDFJS_ASSETS).filter((a) => !a.includes('.wasm.'))) {
    const source = read('assets/pdfjs', asset).toString('utf8');
    assert.doesNotMatch(source, /new Function\s*\(|\beval\s*\(/, asset);
  }
});
