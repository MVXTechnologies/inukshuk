/**
 * The bundled pdf.js 6 files (assets/pdfjs/, see scripts/pdfjs/assets.mjs)
 * as the rasterizer page needs them. Everything is read from the app's own
 * assets: nothing is ever fetched from the network.
 *
 * - `main` / `worker`: the legacy ES-module builds, as text. The page inlines
 *   them (PdfRasterizer `buildHtml`).
 * - `wasm`: the JPEG 2000 and JBIG2 decoders, base64. The page hands them to
 *   pdf.js through its own `BinaryDataFactory`, so they work in served AND
 *   inline mode without a URL.
 * - `fallbacks`: the plain-JS decoders pdf.js imports by URL when the
 *   WebView has no WebAssembly (iOS Lockdown Mode). Only the served page can
 *   import them, from {@link PDFJS_SERVED_DIR} on the loopback server.
 */
import { copyToServed } from '@data/localServer';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';

// The `.pdfjs` extension is a Metro asset extension (metro.config.js), so
// these resolve to asset ids and ship inside the app. Metro asset modules can
// only be referenced with `require()`.
/* eslint-disable @typescript-eslint/no-require-imports */
const MAIN = require('../../../assets/pdfjs/pdf.legacy.min.mjs.pdfjs') as number;
const WORKER = require('../../../assets/pdfjs/pdf.worker.legacy.min.mjs.pdfjs') as number;
const WASM: Readonly<Record<string, number>> = {
  'openjpeg.wasm': require('../../../assets/pdfjs/openjpeg.wasm.pdfjs') as number,
  'jbig2.wasm': require('../../../assets/pdfjs/jbig2.wasm.pdfjs') as number,
};
const FALLBACKS: Readonly<Record<string, number>> = {
  'openjpeg_nowasm_fallback.js': require('../../../assets/pdfjs/openjpeg_nowasm_fallback.js.pdfjs') as number,
  'jbig2_nowasm_fallback.js': require('../../../assets/pdfjs/jbig2_nowasm_fallback.js.pdfjs') as number,
};
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Where the served page finds the no-WebAssembly decoders: pdf.js' `wasmUrl`,
 * relative to the page (`.rasterizer/index.html`), on the served allowlist.
 */
export const PDFJS_SERVED_DIR = '.rasterizer/pdfjs';

export interface PdfjsSources {
  main: string;
  worker: string;
  /** Decoder file name (`openjpeg.wasm`, …) → its bytes, base64. */
  wasm: Record<string, string>;
  /** Fallback file name → local `file://` uri of the bundled asset. */
  fallbacks: Record<string, string>;
}

async function localUri(module: number): Promise<string> {
  const asset = await Asset.fromModule(module).downloadAsync();
  return asset.localUri ?? asset.uri;
}

/** Read every bundled pdf.js file. Rejects if any is missing. */
export async function loadPdfjsSources(): Promise<PdfjsSources> {
  const wasmNames = Object.keys(WASM);
  const fallbackNames = Object.keys(FALLBACKS);
  const [mainUri, workerUri, wasmUris, fallbackUris] = await Promise.all([
    localUri(MAIN),
    localUri(WORKER),
    Promise.all(wasmNames.map((name) => localUri(WASM[name] as number))),
    Promise.all(fallbackNames.map((name) => localUri(FALLBACKS[name] as number))),
  ]);
  const [main, worker, wasm64] = await Promise.all([
    new File(mainUri).text(),
    new File(workerUri).text(),
    Promise.all(wasmUris.map((uri) => new File(uri).base64())),
  ]);
  const wasm: Record<string, string> = {};
  wasmNames.forEach((name, i) => {
    wasm[name] = wasm64[i] ?? '';
  });
  const fallbacks: Record<string, string> = {};
  fallbackNames.forEach((name, i) => {
    fallbacks[name] = fallbackUris[i] ?? '';
  });
  return { main, worker, wasm, fallbacks };
}

/**
 * Copy the no-WebAssembly decoders under {@link PDFJS_SERVED_DIR}, where the
 * served page's pdf.js imports them from. Rewritten on every mount, like the
 * page itself, so they always match the bundled pdf.js.
 */
export async function stagePdfjsFallbacks(fallbacks: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(fallbacks).map(([name, uri]) => copyToServed(uri, `${PDFJS_SERVED_DIR}/${name}`)),
  );
}
