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

**See-through white on native tiles.** The native renderers cannot key white.
For a keyed request the provider copies the native PNG to
`Documents/.rasterizer/key-<id>.png` (on the served allowlist), the page loads
it same-origin, runs the same one-pass key as a pdf.js render
(`window.__pdfKeyImage`) and posts the keyed PNG; the result then has
`pngDataUri`, and both files are deleted. If the page cannot key a tile
(reloading, 15 s timeout) that crop is retried once through pdf.js, which keys
as it paints. Inline mode keeps keyed renders on pdf.js. Emulator, Beau Lake,
50 %: 252 ms per tile (key pass 3–7 ms), against 2–14 s per tile on pdf.js.

Each native crop still opens the document and page itself (about 190 ms of a
230 ms tile on the emulator; the render and PNG encode are about 25 ms).
Keeping them open across a burst needs a change in the native module, so a
store build.

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
incrementally and coalesces waiting work to the latest camera snapshot.

**Reuse (`@core/geo/pdfTileCache`).** A tile is cached under its page identity
(file, revision, georeference, white-key level) plus its grid cell and width.
Widths come from a fixed ladder (`PDF_TILE_WIDTH_LADDER`, steps of at most
1.33x), so a small pinch keeps the same keys. A cell the camera asks for is
shown without rendering when the cache holds the same cell at least as wide
(a small zoom-out) or all four children of the next level down, each at least
half as wide (a whole-level zoom-out). Everything already rendered for a page
still on screen stays displayed under the fresh tiles until its replacement
covers it (#344), within a fallback budget of 6 Mi pixels / 24 tiles. A zoom
therefore never drops back to the blurry overview. Before this, the hook's
return filtered by the current targets and dropped every fallback, and tiles
carried the page bbox instead of their own.

**Neighbour prefetch.** `planPdfDetailTiles(..., {prefetchMargin, maxPrefetch})`
also plans the ring around the view (one view per side, up to 24 cells, nearest
first) at the same level and width, so each ring cell has the key it will have
once visible. Ring tiles render after every visible tile at
`priority: 'background'`, never show as such, never set the Library's
"rendering" status, and a ring failure never fails, backs off, pauses or
reports the page. A camera move replaces the waiting work with the new
snapshot's.

**Budgets (`pdfTileBudgets`).** On-screen textures: 6 Mi pixels visible plus
6 Mi pixels of fallback. Exact tiles take the visible budget before stand-ins
(four children cost up to four times the tile they replace); a tile whose
stand-in loses its place is rendered before the ring. Disk cache: 96 files,
36 Mi pixels during handoff, 28 Mi pixels after two seconds settled;
least-recently-used first, tiles the camera no longer wants before the ring.
After an OS memory warning (`AppState` `memoryWarning`) the ring stops and the
caches shrink (2 Mi fallback, 40 files, 8 Mi settled). Displayed files are
never deleted. Unmount deletes cached files, and native files returned after
unmount are deleted without adoption.

**Held document.** Detail requests pass `holdKey` (the page's file and
revision). The page keeps that document, its page and layer plan open for
8 s after a successful paint, and a request with the same key reuses them:
pdf.js keeps the page's operator list, so the next tile only paints. Any other
request, any failure and the idle timer release it. Beau Lake US Topo, 1024 px
tiles, headless Chrome: 742 ms -> 143 ms per tile.

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
  for 12s the page moves pdf.js to its main-thread fake worker (see "Worker
  mode") and retries once.
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
- **Loopback liveness.** iOS can reclaim the server's listening socket while
  the app is suspended; lighttpd keeps running and the static-server library
  still reports ACTIVE, but every connection is refused (#381, #385, "Load
  failed … (0 B read)"). The provider therefore probes the server (a `HEAD /`
  with a 1.5 s timeout; any HTTP answer counts) on return from the background,
  before served work after 60 s without proof of life, after a served
  transport failure and when the page fails to load. A dead server is
  restarted — on the same port when it can be bound again, so issued URLs stay
  valid — and the page reloaded; the request that hit it is retried once and,
  failing again, rejects as `PdfLoopbackUnavailableError` (a "not started"
  error: its page is never paused). More than 3 restarts in 10 min, or a failed
  restart, falls back to inline mode; the next resume tries to leave it. Policy:
  `@core/storage/loopbackLiveness`.

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
iOS (WKWebView) and Android (System WebView).

**Main-thread fallback (#554).** pdf.js's "fake worker" is not self-contained:
it runs the worker's `WorkerMessageHandler` on the page's thread, taken from
`window.pdfjsWorker` or else loaded with `<script src=workerSrc>`, and it
caches a failure for the page's lifetime. So the page never relies on loading
the worker by URL: `useMainThreadWorker()` evaluates the bundled worker source
into the page, which defines `window.pdfjsWorker`, and pdf.js then uses it for
every later document. This happens

- at startup in **inline mode**, whose `about:blank` page has an opaque origin.
  There pdf.js would wrap the blob URL in a second blob that `importScripts()`
  it, and one Android 11 WebView failed every render with
  `Setting up fake worker failed: "…"`;
- when the Blob worker cannot be created;
- on the load watchdog's retry. The retry used to clear `workerSrc`, which
  makes pdf.js throw `No "GlobalWorkerOptions.workerSrc" specified` before it
  starts, so the request hung until the 45 s timeout.

Rendering on the main thread is fine because the WebView is hidden and
offscreen. `PdfRasterizer.fakeWorker.test.tsx` runs the page with the real
pdf.js bundles, with no usable Worker and no script loading by URL.

## PDF layers (optional content, #477)

GeoPDFs carry their content in optional-content groups. A 2024 USGS US Topo
sheet hides its **Orthoimage** (203 JPEG strips, ~107 Mpx) and **Shaded
Relief** (one ~105 Mpx JPEG) by default, but pdf.js 3.11 only applies layer
visibility when _painting_: its worker still fetched and decoded every hidden
image while building the operator list. On a 58 MB sheet that was ~80 % of the
render.

- **Layer plan.** After the document opens, the page reads its layer config and
  applies `__inkPlanLayers` (`@core/geo/pdfLayers`): document defaults, plus
  aerial/orthoimagery forced **off** (older sheets ship it on). The config is
  passed to `page.render` as `optionalContentConfigPromise`.
- **Worker filter.** The bundled worker is patched at HTML-build time
  (`@core/geo/pdfWorkerPatch`: four exact-text insertions into the minified
  evaluator, all-or-nothing; the runtime is prepended). The page posts the final
  visibility map to the worker on pdf.js' own port before the render asks for
  the operator list, and the worker drops image/form XObjects, inline images and
  shadings inside hidden sections (and images/forms whose own `/OC` is hidden)
  before fetching or decoding them. Visibility uses pdf.js' own rules, and
  anything unknown counts as visible, so the filter can only remove what pdf.js
  would not have painted. If the patch doesn't apply (another pdf.js build),
  the page logs it and renders unfiltered. `pdfWorkerPatch.test.ts` fails if
  the shipped asset stops matching.
- **Native handoff.** A page whose layer plan draws differently from the
  document defaults is not handed to the native renderers (they draw the
  defaults), so the overview and its detail tiles always show the same layers.
  Imagery switched off under an "Images" parent that is already off by default
  draws nothing different (`drawnChanged` is empty): a 2024 US Topo keeps its
  native detail tiles, as before #478.

Measured on `ME_Portland_West_20240805_TM_geo.pdf` (58.6 MB), 2048 px overview,
through this page's own script in headless Chrome with the served range path:
6.1–6.4 s → 1.27–1.30 s, byte-identical PNG. A detail crop: 6.1 s → 1.1 s.
A scanned historical sheet with no layers is unchanged (3.0 s both ways).
These are desktop numbers, not device numbers.

Render time barely depends on the raster width (768 px 1.13 s, 4096 px 1.53 s
for the sheet above). The cost is per operator (~580k here), not per pixel, so
a low-resolution first pass would cost nearly as much as the real one.

Not yet: a per-map "Show aerial imagery layer" switch (the plan already takes
`showImagery`; the page passes `false`). Existing overview PNGs are keyed as
before and are not re-rendered. A sheet whose imagery is on by default keeps
its imagery overview until it is re-imported, while new detail tiles leave the
imagery out.

## Why pdfjs-dist 3.11.174

- It ships a **legacy UMD** build (`legacy/build/pdf.min.js` +
  `pdf.worker.min.js`) — a single global `window.pdfjsLib`, no ESM/`import`,
  Babel-lowered to broadly-supported syntax. That is exactly what loads reliably
  inside a WebView's JS engine on both platforms.
- pdf.js v4/v5 legacy builds still rely on newer runtime features
  (`Promise.withResolvers`, `structuredClone`, `Array.prototype.at`, etc.) that
  are not guaranteed in older Android System WebViews, so v3 is the safer floor
  for an offline trail app that may run on older devices.

### Security: CVE-2024-4367 (GHSA-wgrm-67xf-hhpq)

pdf.js up to 4.1.392 can run JavaScript embedded in a malicious PDF: a font's
`FontMatrix` reaches glyph-drawing code that pdf.js compiles with
`new Function`. In 3.11.174 that compile only happens when `isEvalSupported` is
true, which is pdf.js' default. The same flag also gates the worker's
PostScript (Type 4) function compiler, the build's only other eval sink.

**Mitigation (in place).** Every `getDocument` call on the page passes
`isEvalSupported: false`: served, inline, and the watchdog's retry of each.
pdf.js then draws glyphs through a plain command loop and never evaluates
PDF-derived text. `PdfRasterizer.security.test.tsx` checks the option on all
four calls. It also checks that the shipped asset's eval sinks are still the
gated ones, so replacing the asset fails the test until someone re-reviews it.
There is no scripting surface: pdf.js 3.11's `getDocument` has no
`enableScripting`, and the page never loads `pdf.sandbox` or an annotation
layer.

If script did run, it would run in the hidden WebView. It could
post forged results to RN and read the loopback allowlist (`maps/`,
`offline-styles/`, `.rasterizer/`). It has no file access
(`allowFileAccess={false}`). There is no page CSP and no navigation filter, so
the network is not blocked.

**Real fix: upgrade.** There is no patched 3.x (3.11.174 is the last). The
first fixed release is 4.2.67 and the current one is 6.4.299, which has no
`new Function` at all. The audit gate stays red on this advisory until the
upgrade ships; it is deliberately not allowlisted. The upgrade is a migration,
not a bump:

- **ESM only since v4.** `legacy/build/pdf.min.mjs` (524 KB) and
  `pdf.worker.min.mjs` (1.3 MB). The page must load pdf.js as an inline
  `<script type="module">`, which still sets `globalThis.pdfjsLib`. Module
  scripts run deferred, so the page script must wait for it. pdf.js creates
  the Blob worker as `{type: "module"}`. The main-thread fallback (#554/#560)
  must define `globalThis.pdfjsWorker` from the worker module.
- **Layers.** `OptionalContentConfig.getGroups()` is gone (6.x has
  `getGroup(id)` and iteration), so `prepareLayers` would silently return "no
  layers" and US Topo orthoimage would be painted again.
- **Worker patch.** The four exact-text insertions (`pdfWorkerPatch`) target
  the 3.11 minified evaluator. They will not match 6.x. The page then renders
  unfiltered (about 5× slower on US Topo, #478) until the patch is redone, or
  until 6.x is shown to skip hidden content on its own.
- **JPEG 2000 / JBIG2.** In 6.x these decoders are wasm modules
  (`openjpeg`, `jbig2`, plus `*_nowasm_fallback.js`) loaded from `wasmUrl`. They
  must be bundled and served from the loopback server. Inline mode
  (`about:blank`) has nowhere to load them from.
- **Runtime APIs.** 6.x uses `Promise.withResolvers`, `structuredClone`,
  `Uint8Array.fromBase64` and `Map.prototype.getOrInsertComputed`. Check the
  legacy build's polyfills against iOS 16.4 WKWebView and the oldest Android
  System WebView we support.
- **Tests.** `orientation.pdfjs.test.ts` and `pdfWorkerPatch.pdfjs.test.ts`
  load `pdfjs-dist/legacy/build/pdf.js` (CJS) in Jest. 6.x has no CJS entry and
  needs Node ≥ 22.13.

All of it ships OTA: pdf.js is a Metro asset (below) and the page is built at
runtime. It still needs on-device validation on both platforms before it can
go out.

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
