/**
 * The pdf.js files the app ships, and where each comes from in the installed
 * `pdfjs-dist` (see src/features/map/PdfRasterizer.README.md, "Asset bundling").
 *
 * They are committed under assets/pdfjs/ with a `.pdfjs` extension, which
 * metro.config.js registers as an asset extension: Metro then bundles them as
 * opaque files instead of parsing them as source. The page is built from them
 * at run time, so a new pdf.js ships over the air like any other asset.
 *
 * `node scripts/pdfjs/sync-assets.mjs` copies them after a `pdfjs-dist`
 * bump; `npm run test:scripts` fails while they differ from the install.
 */

/** Asset file under assets/pdfjs/ → its source under node_modules/pdfjs-dist/. */
export const PDFJS_ASSETS = Object.freeze({
  // The legacy builds: Babel-lowered and core-js-polyfilled for older
  // engines (the page adds the few polyfills they still lack).
  'pdf.legacy.min.mjs.pdfjs': 'legacy/build/pdf.min.mjs',
  'pdf.worker.legacy.min.mjs.pdfjs': 'legacy/build/pdf.worker.min.mjs',
  // JPEG 2000 and JBIG2 decoders. The page hands the wasm to pdf.js itself
  // (no URL needed); the plain-JS fallbacks are served for WebViews without
  // WebAssembly (iOS Lockdown Mode).
  'openjpeg.wasm.pdfjs': 'wasm/openjpeg.wasm',
  'jbig2.wasm.pdfjs': 'wasm/jbig2.wasm',
  'openjpeg_nowasm_fallback.js.pdfjs': 'wasm/openjpeg_nowasm_fallback.js',
  'jbig2_nowasm_fallback.js.pdfjs': 'wasm/jbig2_nowasm_fallback.js',
});

/**
 * Shipped files that are not byte copies. Each is pinned to the source it was
 * made from and to its result, so a pdf.js bump fails `assets.test.mjs` until
 * it is regenerated:
 * - `openjpeg-no-relaxed-simd.mjs` rewrites pdf.js' JPEG 2000 decoder for
 *   engines without relaxed SIMD (all of iOS);
 * - `worker-split-operator-switch.mjs` moves the worker's operator switch into
 *   its own function, which Android WebView 112/113 (V8 11.3) would otherwise
 *   miscompile and crash on.
 */
export const PDFJS_DERIVED_ASSETS = Object.freeze({
  'pdf.worker.legacy.min.mjs.pdfjs': {
    sourceSha256: '145d2dd3ab0c86151011dba95acfa2d5336e2accd59388ea43dbee0efddaaec6',
    sha256: '3407db2a7fba3838134198a077ed8fb4149fa3fee958af1808063dfc6059ce16',
    script: 'scripts/pdfjs/worker-split-operator-switch.mjs',
  },
  'openjpeg.wasm.pdfjs': {
    sourceSha256: '95e5002597af0824004aa57b1900fe019715db389e37640b1e58395e42f00cc5',
    sha256: '8049cafea9079111c1e9fa214569bf557f64bf65f9d8e67100542301dbb85f3b',
    script: 'scripts/pdfjs/openjpeg-no-relaxed-simd.mjs',
  },
});

/**
 * The first pdf.js release without GHSA-wgrm-67xf-hhpq (CVE-2024-4367,
 * arbitrary JavaScript from a crafted font). Shipping anything older fails
 * the asset test.
 */
export const PDFJS_FIRST_PATCHED = '4.2.67';

/** `pdfjsVersion = x.y.z` from a pdf.js build's license header, or null. */
export function builtPdfjsVersion(source) {
  const match = /pdfjsVersion = (\d+\.\d+\.\d+)/.exec(source.slice(0, 4096));
  return match ? match[1] : null;
}

/** Numeric x.y.z comparison: negative, zero or positive. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
