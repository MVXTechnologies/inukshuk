# PdfRasterizer

Fully offline rasterizer for georeferenced PDF map overlays. PDF.js returns a PNG
data URI that callers write to cache before passing a file URI to MapLibre.
Eligible Android and iOS detail crops return an owned PNG file directly.

## Public API

```ts
import { PdfRasterizerProvider, usePdfRasterizer } from '@features/map/PdfRasterizer';

// Mount ONCE near the app root (e.g. in app/_layout.tsx):
<PdfRasterizerProvider>
  <App />
</PdfRasterizerProvider>;

// Anywhere below the provider:
const rasterize = usePdfRasterizer();
const serverOrigin = usePdfRasterizerServer(); // () => Promise<string | null>
const origin = await serverOrigin(); // "http://127.0.0.1:<port>", or null in inline mode
const result = await rasterize({
  source: origin ? { url: `${origin}/maps/<id>.pdf` } : { base64 },
  pageIndex: 0,
  targetWidthPx: 2048,
});
// result.pngDataUri -> "data:image/png;base64,..."
// result.{widthPx,heightPx}        -> rendered raster size
// result.{pageWidthPt,pageHeightPt} -> intrinsic page size in PDF points (1/72")
// result.pageCount                  -> total pages in the document
// result.{loadMs,renderMs}          -> WebView-side timings (document open, page render)
```

`@core/library/rasterSource` is the rule callers use to pick the source: the
URL whenever there is an origin, base64 only for files under 16 MB without
one, and a clear refusal above that (#269).

On the served path the page wraps `fetch` (#331): every request pdf.js makes
is traced (path, `Range`, status, bytes read, failure), and a render error is
suffixed with `[served fetch: N requests, F failed; GET /maps/<id>.pdf
bytes=A-B -> 206 (X B read) failed: <reason>]` once any fetch failed. WebKit
reports every network failure inside the page as a bare `TypeError: Load
failed` — the whole content of auto-reports #279/#280 — and this names the
request instead. `PdfRasterizer.served.test.tsx` runs the page script against
a real loopback `http` server with Range support to pin the wording.

## Native detail acceleration

Detail requests can provide `crop` and `nativePage: {fileUri, revision,
expectedPageWidthPt, expectedPageHeightPt}`. On rebuilt Android and iOS binaries,
PDF.js first verifies rotation 0, UserUnit 1, and a zero-origin visible page box
matching the georeference dimensions. It releases its document before handing
the crop to the local `InukshukPdf` module. Other geometries and binaries without
the optional module retain PDF.js rendering.

Android uses `PdfRenderer`. iOS accepts only a single opaque baseline, interleaved
8-bit RGB JPEG paint, with strict page, image and content checks. Text, paths,
clipping, forms, masks, blending, annotations and unsupported JPEG encodings use
PDF.js. The iOS implementation lazily crops the embedded JPEG with ImageIO;
it never draws the full PDF page with CoreGraphics. See the
[native module notes](../../../modules/inukshuk-pdf/README.md) and
[iOS validation and benchmark notes](../../../modules/inukshuk-pdf/ios/README.md).

The native worker renders only a bounded crop bitmap and writes lossless opaque
PNG directly to cache, capped at 3072 pixels per edge and 3 Mi pixels per crop.
The result has `fileUri` instead of `pngDataUri`; callers
own this file and must delete abandoned results. Successful geometry checks are
cached in a 16-entry LRU keyed by file revision, source, page and dimensions, so
later crops skip PDF.js. Native failure or timeout invalidates eligibility.
An `E_PDF_UNSUPPORTED` result retries the same request once through PDF.js with
native handoff disabled, preventing a fallback loop. Other native rendering
errors retain the overview. Both paths retain file ownership until the result
is adopted or deleted.

On the API 35 Android emulator, the original EcoLL1 1896×1659 crop took 335 s in
PDF.js. The integrated native path completed three successive crops in
1.3–1.4 s each, including writing PNG; Anticosti and NORD sample crops took
0.84 s and 2.94 s. These are provider timings, not measured frame-presentation
latency or physical-device guarantees. Rebuilding Android is required to gain
the Android native module; iOS also requires an updated native build. An OTA
alone cannot add native code. These historical crop benchmarks do not measure
completion of an entire tiled viewport.

### Detail tiles and cache

`usePdfDetails` selects up to two eligible pages and requests stable, center-first
tiles from `planPdfDetailTiles`. Each page has at most 24 tiles. The visible raster
budget is 6 Mi pixels total: one page receives 6 Mi pixels; two pages receive
3 Mi pixels each. Individual tiles still obey the 3072-edge/3 Mi-pixel crop caps.
Dyadic tile geometry preserves the overview's two-triangle mapping, including
crops that cross its diagonal.

Tiles use IDs `${overview.id}:tile:${plan.tileKey}` and carry
`parentId: overview.id`, so the map groups each detail with its own overview
without duplicate source/layer IDs. The hook displays completed tiles
incrementally, reuses matching cached tiles immediately during pans, and
coalesces waiting work to the latest camera snapshot. Only tiles in that current
snapshot are displayed; obsolete completions may enter the bounded reuse cache.

Cache accounting uses returned raster width and height, with a geometry estimate
when dimensions are unavailable. Current visible files are pinned. The cache is
limited to 64 files and 18 Mi pixels during handoff, with cleanup to 12 Mi pixels
after two seconds. Unmount deletes cached files, and native files returned after
unmount are deleted without adoption.

## How it works

A single hidden offscreen `react-native-webview` is the rendering engine. The
provider mounts it once at a 1×1, fully-transparent, off-screen position so its
JavaScript runs without painting anything visible or affecting layout.

1. On mount, the provider reads the two **bundled** pdf.js files from app assets
   and inlines them into a self-contained HTML string (`buildHtml`).
2. **Served mode (normal, #269).** The provider takes a lease on the app's
   shared loopback server (`@data/localServer` — root = the document
   directory), writes the HTML to `Documents/.rasterizer/index.html` (rewritten
   on every mount; the URL carries an FNV-1a hash of the content so no WebView
   cache can serve a stale page), and loads it with
   `source={{ uri: origin + '/.rasterizer/index.html?v=<hash>' }}`. Imported
   PDFs live in `Documents/maps/`, so page and PDF are **same-origin**.
   **Inline mode (fallback).** If the server cannot start — or the served page
   fails to load — the same HTML is loaded via `source={{ html }}` and the PDF
   crosses the bridge as base64, as it did before #269.
3. The pdf.js main bundle runs inside its own `<script>` tag and exposes
   `window.pdfjsLib`. When ready, the page posts `{ id: "__ready__", ok: true }`
   back to RN.
4. To render, RN injects JavaScript over the bridge:
   - served: `window.__pdfRender(id, pageIndex, targetWidthPx, url)` — four
     small values. The page calls
     `pdfjsLib.getDocument({ url, rangeChunkSize: 1 MiB, disableAutoFetch: true, disableStream: true })`;
     lighttpd answers `Range` requests, `disableStream` cancels the full-body
     request as soon as the headers show range support, and `disableAutoFetch`
     stops pdf.js pulling the rest of the file in the background — only the
     chunks the page references are ever fetched.
   - inline: `window.__pdfReset()`, then `window.__pdfAppend(chunk)` once per
     256 KB base64 chunk, then `window.__pdfRender(id, pageIndex, targetWidthPx, null)`,
     which decodes the base64 to a `Uint8Array` and calls
     `pdfjsLib.getDocument({ data })`.
     Either way the page grabs `getPage(pageIndex + 1)`, computes
     `scale = targetWidthPx / viewport(scale:1).width`, renders to an offscreen
     `<canvas>`, and reports `canvas.toDataURL('image/png')`.
5. The WebView posts `{ id, ok: true, pngDataUri, widthPx, heightPx, pageWidthPt,
pageHeightPt, pageCount, loadMs, renderMs }` (or `{ id, ok: false, error }`)
   back, which the provider matches to the pending promise by `id`.

Why the split: before #269 every PDF took the inline path, and every step of it
scaled with file size — a 216 MB GeoPDF became 289 MB of base64, ~1,100 bridge
evaluations and an `atob` loop before pdf.js even started. Android's
`File.base64()` OOMed at ~150 MB (#218) and iOS never finished inside the
timeout (#264, #265). On the served path nothing that crosses the bridge grows
with the file.

### Queueing, timeouts, resilience

- Requests are **serialized** through an internal FIFO queue — only one render
  runs at a time because the WebView and its canvas are a single shared
  resource. `priority: 'background'` requests (the import-time pre-render,
  #272 step 2, `usePrerenderOnImport`) wait behind every queued interactive
  request; a render already in progress is never preempted.
- Each request has a **45s timeout**; on timeout the promise rejects and the
  PDF.js WebView is replaced before the queue resumes. Native rendering cannot
  be hard-cancelled by either native backend: a timeout rejects the caller but
  retains the slot until native work settles, then deletes its abandoned file.
- A **12s load watchdog** inside the page guards against the Android System
  WebView's Blob worker wedging silently: if `getDocument` makes no progress
  for 12s the page forces pdf.js's main-thread fake worker and retries once.
  On the served path every range request re-arms it, so a big file that takes
  longer than 12s to open (but is progressing) is not mistaken for a stall.
- Errors after the document opened (page out of range, render failure) are
  posted immediately; they used to be swallowed and surface only as the
  timeout.
- If the WebView reloads or its content process crashes, `onLoadStart` flips the
  engine back to "not ready"; when the reloaded page re-posts `__ready__`, the
  queue resumes automatically.
- On provider unmount, all still-pending promises are rejected so callers never
  hang.

## Asset bundling (the offline guarantee)

The pdf.js **legacy UMD** builds are copied into `assets/pdfjs/`:

| Asset file (in repo)             | Source (node_modules)                       |
| -------------------------------- | ------------------------------------------- |
| `pdf.legacy.min.js.pdfjs`        | `pdfjs-dist/legacy/build/pdf.min.js`        |
| `pdf.worker.legacy.min.js.pdfjs` | `pdfjs-dist/legacy/build/pdf.worker.min.js` |

The files use a custom **`.pdfjs`** extension, registered as a Metro **asset**
extension in `metro.config.js`:

```js
config.resolver.assetExts = [...config.resolver.assetExts, 'pdfjs'];
```

That makes `require('../../../assets/pdfjs/pdf.legacy.min.js.pdfjs')` return a
Metro asset module id (instead of Metro trying to parse a 370 KB minified UMD
bundle as source). At runtime:

```ts
const asset = await Asset.fromModule(PDFJS_MAIN_ASSET).downloadAsync();
const source = await new File(asset.localUri ?? asset.uri).text(); // expo-file-system File API
```

`downloadAsync()` here just materializes the **bundled** asset onto the local
filesystem (in dev it may copy from the Metro dev server; in a release build the
asset already ships inside the app). The text is then inlined into the HTML.

`app.config.ts` sets `assetBundlePatterns: ['**/*']`, so the `.pdfjs` assets are
packaged into the standalone app.

**Offline guarantee:** the rendered HTML document references nothing remote — no
CDN, no `<script src="https://...">`. pdf.js, its worker and the canvas all live
inside the WebView; the only thing it ever fetches is the PDF, from the app's
own loopback server on `127.0.0.1` (served mode) or from the bridge (inline
mode). The WebView is configured with `allowFileAccess={false}`. The server
itself only exposes the allowlisted folders `maps/`, `offline-styles/` and
`.rasterizer/` (`@core/storage/servedPaths`); the rest of the document
directory — the library index, trails, photos — is denied by lighttpd's
`mod_access`, so nothing else on the device can read it through that port.

## Worker mode

pdf.js parses PDFs in a Web Worker by default. To stay offline, the inlined
script builds a **same-origin Blob-URL worker** from the bundled worker source:

```js
const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob));
```

Blob URLs are same-origin and require no network, so this works offline on both
iOS (WKWebView) and Android (System WebView). If `new Worker(...)` throws on a
given WebView, the code falls back to pdf.js's **main-thread "fake worker"** by
clearing `workerSrc`; rendering still succeeds, just on the UI thread of the
WebView (which is fine because the WebView is hidden/offscreen).

## Why pdfjs-dist 3.11.174

- It ships a **legacy UMD** build (`legacy/build/pdf.min.js` +
  `pdf.worker.min.js`) — a single global `window.pdfjsLib`, no ESM/`import`,
  Babel-lowered to broadly-supported syntax. That is exactly what loads reliably
  inside a WebView's JS engine on both platforms.
- pdf.js v4/v5 legacy builds still rely on newer runtime features
  (`Promise.withResolvers`, `structuredClone`, `Array.prototype.at`, etc.) that
  are not guaranteed in older Android System WebViews, so v3 is the safer floor
  for an offline trail app that may run on older devices.

## Limitations

- **One render at a time.** Calls queue; a long page blocks subsequent ones.
- **Memory.** Overview rasters are capped at 4096 pixels per edge and 8 Mi pixels;
  detail crops at 3072 pixels per edge and 3 Mi pixels. These bound output
  allocations, not all PDF decoder memory. The PDF.js canvas is shrunk to 1×1
  right after `toDataURL` to release memory promptly.
- **Data-URI size.** PDF.js returns its PNG as a base64 data URI over the bridge;
  for very large rasters this transfer is non-trivial. The WebView cannot write
  to the filesystem here, so the way to bound it is to lower `targetWidthPx`.
- **No font/asset fetching.** Standard fonts embedded in the PDF render fine.
  pdf.js's optional standard-font and CMap packs are **not** bundled, so a PDF
  that relies on non-embedded CJK fonts may render with substitutes. Trail maps
  almost always embed their fonts, so this is rarely an issue.
- **Dev vs. release.** In a release/standalone build the assets are bundled and
  fully offline. In Expo dev mode, `downloadAsync` may pull the asset from the
  Metro dev server the first time — that is a dev-only convenience, not a
  runtime network dependency of the shipped app.

## Sanity check

`src/features/map/__tests__` is not used for this; instead a lightweight Node
check (`scripts/pdfjs-sanity` is intentionally not committed as a heavy test
dep) confirmed that the legacy build files exist and that the main bundle begins
evaluating once browser globals (`URLSearchParams`, DOM) are present — i.e. the
only thing it needs is a real browser/WebView environment, which is exactly
where it runs. A full pixel render can only be verified on a device/simulator.
