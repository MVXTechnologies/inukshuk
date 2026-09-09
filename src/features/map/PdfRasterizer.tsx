import { PdfRenderNotStartedError } from './pdfRenderFailure';
import { type PdfCrop } from '@core/geo/pdfDetail';
/**
 * PdfRasterizer — fully-offline PDF page → PNG rasterizer for MapLibre overlays.
 *
 * A single hidden offscreen `WebView` (mounted once by `PdfRasterizerProvider`)
 * acts as the rendering engine. The WebView hosts a self-contained HTML document
 * with the pdf.js *legacy UMD* build inlined from app-bundled assets — it never
 * touches the network.
 *
 * Two ways the PDF reaches the page (#269):
 *
 * - **Served (normal).** The page is written under Documents and loaded from the
 *   app's loopback server (`@data/localServer`), where the imported PDFs live
 *   too — same origin. RN sends `{ id, url, pageIndex, targetWidthPx }` and
 *   pdf.js range-fetches only the bytes the page needs. Nothing scales with
 *   file size on the bridge; a 216 MB GeoPDF costs the same as a 3 MB one.
 * - **Inline (fallback).** If the server cannot start, the page loads as an
 *   inline `html` string and the PDF crosses the bridge as base64 chunks, the
 *   way every map did before #269. That path OOMs on big files (#218), so
 *   callers only take it for small ones (`@core/library/rasterSource`).
 *
 * PDF.js returns a PNG through `postMessage`. Eligible Android detail crops
 * instead hand validated geometry to the native renderer and return a file URI.
 *
 * See `PdfRasterizer.README.md` for the bundling/offline design and limitations.
 */
import { fnv1a32 } from '@core/encoding/fnv1a';
import { servedFileUrl } from '@core/storage/servedPaths';
import { acquireLocalServer, writeServedText, type LocalServerLease } from '@data/localServer';
import { nativePdfAvailable, renderNativePdfCrop, deleteNativePdfOutput } from '@data/nativePdf';
import { beginPdfRender, finishPdfRender } from '@data/pdfRenderRecovery';
import { reportError } from '@lib/errorReporting';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from 'react-native-webview/lib/WebViewTypes';

// The bundled pdf.js builds. The `.pdfjs` extension is registered as a Metro
// asset extension (see metro.config.js) so these resolve to local file URIs at
// runtime and ship inside the app — guaranteeing offline operation. Metro asset
// modules can only be referenced with `require()`, so we opt out of the import
// rule for this block.
/* eslint-disable @typescript-eslint/no-require-imports */
const PDFJS_MAIN_ASSET = require('../../../assets/pdfjs/pdf.legacy.min.js.pdfjs') as number;
const PDFJS_WORKER_ASSET =
  require('../../../assets/pdfjs/pdf.worker.legacy.min.js.pdfjs') as number;
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Per-request timeout. Generous enough to cover the worker watchdog (12s) plus a
 * full main-thread fake-worker retry render of a multi-MB page.
 *
 * Measured on the Android emulator (Pixel 6 profile, 4 GB, software GL) with
 * the served path: the 216 MB UTM sheet in #269 renders at 2048 px well inside
 * this budget (see the issue for the numbers), so it stays at 45 s.
 */
const RENDER_TIMEOUT_MS = 45_000;

/** Default target raster width in CSS px when the caller does not specify one. */
const DEFAULT_TARGET_WIDTH_PX = 2048;

/** Max base64 characters injected per chunk (inline mode) to stay under bridge size limits. */
const BASE64_CHUNK_SIZE = 256 * 1024;

/**
 * Where the rasterizer page lives under Documents. On the server's allowlist
 * (`SERVED_DOCUMENT_PREFIXES`); the file is rewritten on every provider mount
 * and its URL carries a content hash, so a stale copy can never outlive the
 * code that generated it.
 */
const RASTERIZER_PAGE_PATH = '.rasterizer/index.html';

/** Where the PDF bytes come from. */
export type RasterizeSource =
  /** Same-origin URL on the loopback server; pdf.js range-fetches it. */
  | { url: string; base64?: undefined }
  /** PDF file contents as base64 (no data: prefix), pushed over the bridge. */
  | { base64: string; url?: undefined };

export interface RasterizeArgs {
  source: RasterizeSource;
  /** 0-based page index to render. */
  pageIndex: number;
  /** Target render width in CSS px; height derived from page aspect. Default 2048. */
  targetWidthPx?: number;
  /** Visible crop in normalized, unrotated top-left page space. */
  crop?: PdfCrop | null;
  nativePage?: {
    fileUri: string;
    revision: string;
    expectedPageWidthPt: number;
    expectedPageHeightPt: number;
  } | null;
  /**
   * Queue placement. `interactive` (default) is something the map is waiting
   * for and goes ahead of every queued `background` request; `background` is
   * the import-time pre-render (#272 step 2) and only runs once nothing
   * interactive is waiting. A render already in progress is never preempted.
   */
  priority?: RasterizePriority;
}

export type RasterizePriority = 'interactive' | 'background';

export type RasterResult = (
  { pngDataUri: string; fileUri?: undefined } | { fileUri: string; pngDataUri?: undefined }
) & {
  /** Rendered raster size in pixels. */
  widthPx: number;
  heightPx: number;
  /** The page's intrinsic size in PDF points (1/72 inch). */
  pageWidthPt: number;
  pageHeightPt: number;
  /** Total pages in the document. */
  pageCount: number;
  /** Wall-clock ms inside the WebView: document open, and page render. */
  loadMs: number;
  renderMs: number;
};

/** Shape of the success/error messages the WebView posts back to RN. */
interface WebViewSuccessMessage {
  kind?: undefined;
  id: string;
  ok: true;
  pngDataUri: string;
  widthPx: number;
  heightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
  pageCount: number;
  loadMs: number;
  renderMs: number;
}
interface WebViewErrorMessage {
  kind?: undefined;
  id: string;
  ok: false;
  error: string;
  resetEngine?: boolean;
}
interface WebViewReadyMessage {
  id: '__ready__';
  ok: boolean;
}
interface WebViewNativeMessage {
  id: string;
  ok: true;
  kind: 'native-geometry';
  pageWidthPt: number;
  pageHeightPt: number;
}
type WebViewResultMessage = WebViewSuccessMessage | WebViewErrorMessage | WebViewNativeMessage;
type WebViewMessage = WebViewResultMessage | WebViewReadyMessage;

/** True for render-result messages (everything that is not the readiness ping). */
function isResultMessage(message: WebViewMessage): message is WebViewResultMessage {
  return message.id !== '__ready__';
}

/** Geometry belongs to one immutable document revision, page, and served source. */
function nativeGeometryKey(args: Required<RasterizeArgs>): string | null {
  const page = args.nativePage;
  return page
    ? JSON.stringify([
        page.fileUri,
        page.revision,
        args.pageIndex,
        page.expectedPageWidthPt,
        page.expectedPageHeightPt,
        args.source.url ?? fnv1a32(args.source.base64),
      ])
    : null;
}
/** Native unsupported errors can depend on decoder area/aspect budgets. */
function nativeRequestKey(args: Required<RasterizeArgs>): string | null {
  const pageKey = nativeGeometryKey(args);
  const crop = args.crop;
  return pageKey !== null
    ? JSON.stringify([
        pageKey,
        crop ? [crop.x0, crop.y0, crop.x1, crop.y1] : null,
        args.targetWidthPx,
      ])
    : null;
}
const NATIVE_GEOMETRY_CACHE_LIMIT = 16;

interface PendingRequest {
  backendDispatched: boolean;
  args: Required<RasterizeArgs>;
  recoveryPage: { fileUri: string; pageIndex: number } | null;
  recoveryToken: string | null;
  resolve: (result: RasterResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  expire: () => void;
}

function finishRecovery(pending: PendingRequest): void {
  if (pending.recoveryToken === null) return;
  try {
    finishPdfRender(pending.recoveryToken);
  } catch (error) {
    reportError(error, 'pdf-render-recovery-cleanup');
  }
  pending.recoveryToken = null;
}

type RasterizeFn = (args: RasterizeArgs) => Promise<RasterResult>;

/**
 * Resolves to the loopback origin the engine serves PDFs from, or `null` when
 * the engine runs in inline (bridge) mode. Waits for the mode to be decided.
 */
type ServerOriginFn = () => Promise<string | null>;

interface RasterizerContextValue {
  rasterize: RasterizeFn;
  serverOrigin: ServerOriginFn;
}

const PdfRasterizerContext = createContext<RasterizerContextValue | null>(null);

/** How the WebView is fed: the served page URL, or the inline document. */
type Engine = { kind: 'served'; uri: string } | { kind: 'inline'; html: string };

/**
 * Build the offscreen HTML document, inlining the pdf.js main + worker bundles.
 *
 * The worker is wired up as a same-origin Blob-URL `Worker` so pdf.js parses
 * off the main thread while staying fully offline. If Blob workers are
 * unavailable on a given WebView, pdf.js transparently falls back to its
 * main-thread "fake worker", so rendering still succeeds (just less smoothly).
 */
function buildHtml(pdfMainSource: string, pdfWorkerSource: string): string {
  // The worker source is embedded as a JSON string literal so no `</script>` or
  // other content inside it can break out of the document. The main bundle is
  // injected directly inside its own <script> element so pdf.js evaluates at
  // load time and exposes window.pdfjsLib.
  const workerLiteral = JSON.stringify(pdfWorkerSource);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>html,body{margin:0;padding:0;background:#fff;}#stage{position:absolute;left:-99999px;top:0;}</style>
</head>
<body>
<div id="stage"><canvas id="canvas"></canvas></div>
<script>${pdfMainSource}</script>
<script>
(function () {
  'use strict';
  var WORKER_SOURCE = ${workerLiteral};
  // Keep this ES-compatible function literal: Hermes cannot serialize a
  // compiled function back to source with Function.prototype.toString().
  function cropGeometry(pageWidth, pageHeight, targetWidth, crop) {
    var r = crop || { x0: 0, y0: 0, x1: 1, y1: 1 };
    if (![pageWidth, pageHeight, targetWidth, r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) ||
        pageWidth <= 0 || pageHeight <= 0 || targetWidth <= 0 ||
        r.x0 < 0 || r.y0 < 0 || r.x1 > 1 || r.y1 > 1 || r.x1 <= r.x0 || r.y1 <= r.y0) {
      throw new Error('Invalid PDF crop dimensions');
    }
    var width = pageWidth * (r.x1 - r.x0);
    var height = pageHeight * (r.y1 - r.y0);
    var edge = crop ? 3072 : 4096;
    var pixels = (crop ? 3 : 8) * 1024 * 1024;
    var scale = Math.min(targetWidth / width, edge / width, edge / height, Math.sqrt(pixels / (width * height)));
    return { widthPx: Math.max(1, Math.floor(width * scale)), heightPx: Math.max(1, Math.floor(height * scale)),
      scale: scale, offsetX: -r.x0 * pageWidth * scale, offsetY: -r.y0 * pageHeight * scale };
  }
  var post = function (msg) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  };

  if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== 'function') {
    post({ id: '__ready__', ok: false, error: 'pdfjsLib failed to load' });
    return;
  }

  // Point pdf.js at the worker via a same-origin Blob URL (fully offline). Using
  // workerSrc — rather than manually constructing a Worker and assigning
  // workerPort — lets pdf.js own the worker lifecycle and, crucially, fall back
  // to its main-thread "fake worker" if the Android System WebView can't spin up
  // a real Blob Worker. The manual workerPort path had no such fallback and hung
  // forever (30s render timeout) when the worker initialized silently-broken.
  try {
    var blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) {
    // Last resort: empty workerSrc forces the main-thread fake worker.
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  }

  // Incremental base64 assembly (inline mode) so multi-MB PDFs never exceed
  // bridge limits.
  var chunks = [];

  window.__pdfReset = function () {
    chunks = [];
  };
  window.__pdfAppend = function (chunk) {
    chunks.push(chunk);
  };

  function base64ToBytes(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // Watchdog: if pdf.js makes no progress opening the document within this
  // window, the real Blob worker has most likely wedged. We then force the
  // main-thread fake worker and retry exactly once, so a hostile WebView worker
  // can't hang us. "Progress" counts: on the served path a 200 MB sheet can
  // legitimately take longer than this to open (pdf.js may have to read a lot
  // of it to find the xref), but a live worker keeps requesting ranges, and
  // each range re-arms the watchdog. A wedged worker requests nothing.
  var LOAD_WATCHDOG_MS = 12000;
  var RANGE_CHUNK_BYTES = 1048576;

  function renderOnce(id, pageIndex, targetWidthPx, input, attempt, crop, nativePage) {
    var params;
    if (input.url) {
      // Served: let pdf.js range-fetch. disableStream cancels the full-body
      // request as soon as the headers show Range support; disableAutoFetch
      // stops it from pulling the rest of the file in the background. Together
      // they mean only the chunks THIS page references ever enter memory.
      params = {
        url: input.url,
        rangeChunkSize: RANGE_CHUNK_BYTES,
        disableAutoFetch: true,
        disableStream: true,
        isEvalSupported: false,
        disableFontFace: false,
      };
    } else {
      var bytes;
      try {
        // Decode fresh each attempt: getDocument may transfer/detach the buffer.
        bytes = base64ToBytes(input.base64);
      } catch (e) {
        post({ id: id, ok: false, error: 'base64 decode failed: ' + (e && e.message) });
        return;
      }
      params = { data: bytes, isEvalSupported: false, disableFontFace: false };
    }

    var t0 = Date.now();
    var loadingTask = window.pdfjsLib.getDocument(params);
    var destruction = null;
    function releaseDocument() {
      if (!destruction) destruction = Promise.resolve().then(function () { return loadingTask.destroy(); });
      return destruction;
    }
    function releaseFailure(err) {
      post({ id: id, ok: false, resetEngine: true, error: 'PDF resource cleanup failed: ' + String(err) });
    }

    // Three-way state, not one flag: a stall hands the id to the retry (so this
    // attempt must go quiet), while an error AFTER the document opened — page
    // out of range, a render failure — must still be posted. One "settled"
    // flag for both used to swallow the latter, and the caller saw only the
    // 45 s timeout instead of the real reason.
    var stalled = false;
    var loaded = false;
    var watchdog = null;
    function onStall() {
      if (stalled || loaded) return;
      stalled = true;
      releaseDocument().then(function () {
        if (attempt === 0) {
          // Drop to the main-thread fake worker and retry once.
          try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = ''; } catch (e) {}
          renderOnce(id, pageIndex, targetWidthPx, input, 1, crop, nativePage);
        } else {
          post({ id: id, ok: false, error: 'pdf load stalled in both worker modes' });
        }
      }, releaseFailure);
    }
    function armWatchdog() {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(onStall, LOAD_WATCHDOG_MS);
    }
    armWatchdog();
    loadingTask.onProgress = function () {
      if (!stalled && !loaded) armWatchdog();
    };

    loadingTask.promise
      .then(function (doc) {
        if (stalled) return undefined;
        loaded = true;
        clearTimeout(watchdog);
        var loadMs = Date.now() - t0;
        var pageCount = doc.numPages;
        var pageNumber = pageIndex + 1;
        if (pageNumber < 1 || pageNumber > pageCount) {
          throw new Error('pageIndex ' + pageIndex + ' out of range (pageCount ' + pageCount + ')');
        }
        return doc.getPage(pageNumber).then(function (page) {
          // Always rasterize in the page's UNROTATED (MediaBox) coordinate space
          // by forcing rotation: 0 — overriding any /Rotate display flag. The
          // georeferencing (VP/Measure BBox + GPTS, and the LGIDict registration)
          // is defined in unrotated user space, so applying /Rotate here would
          // render the image rotated relative to its geo corners, making rotated
          // pages (e.g. a /Rotate 90 landscape sheet) appear flipped and stretched.
          var baseViewport = page.getViewport({ scale: 1, rotation: 0 });
          var pageWidthPt = baseViewport.width;
          var pageHeightPt = baseViewport.height;
          if (nativePage && page.rotate === 0 && page.userUnit === 1 &&
              Array.isArray(page.view) && page.view.length === 4 &&
              page.view[0] === 0 && page.view[1] === 0 &&
              page.view[2] === nativePage.expectedPageWidthPt &&
              page.view[3] === nativePage.expectedPageHeightPt &&
              pageWidthPt === nativePage.expectedPageWidthPt && pageHeightPt === nativePage.expectedPageHeightPt) {
            return releaseDocument().then(function () {
              post({ id: id, ok: true, kind: 'native-geometry', pageWidthPt: pageWidthPt, pageHeightPt: pageHeightPt });
            }, releaseFailure);
          }
          var geometry = cropGeometry(pageWidthPt, pageHeightPt, targetWidthPx, crop);
          var scale = geometry.scale;
          var viewport = page.getViewport({ scale: scale, rotation: 0 });
          var widthPx = geometry.widthPx;
          var heightPx = geometry.heightPx;

          var canvas = document.getElementById('canvas');
          canvas.width = widthPx;
          canvas.height = heightPx;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, widthPx, heightPx);

          var t1 = Date.now();
          return page.render({ canvasContext: ctx, viewport: viewport, transform: [1, 0, 0, 1, geometry.offsetX, geometry.offsetY] }).promise.then(function () {
            var pngDataUri = canvas.toDataURL('image/png');
            // Free the canvas memory before reporting back.
            canvas.width = 1;
            canvas.height = 1;
            var renderMs = Date.now() - t1;
            // Release the document (and, on the served path, its chunk buffer)
            // before the next request; the WebView is a long-lived process.
            return releaseDocument().then(function () {
              post({
                id: id,
                ok: true,
                pngDataUri: pngDataUri,
                widthPx: widthPx,
                heightPx: heightPx,
                pageWidthPt: pageWidthPt,
                pageHeightPt: pageHeightPt,
                pageCount: pageCount,
                loadMs: loadMs,
                renderMs: renderMs,
              });
            });
          });
        });
      })
      .catch(function (err) {
        // A stalled attempt was destroyed on purpose; its rejection belongs to
        // nobody — the retry (or the final stall error) owns the id now.
        if (stalled) return;
        loaded = true;
        clearTimeout(watchdog);
        return releaseDocument().then(function () {
          post({ id: id, ok: false, error: (err && err.message) ? err.message : String(err) });
        }, releaseFailure);
      });
  }

  // \`url\` is null in inline mode: the PDF was streamed in via __pdfAppend.
  window.__pdfRender = function (id, pageIndex, targetWidthPx, url, crop, nativePage) {
    var input;
    if (url) {
      input = { url: url };
    } else {
      input = { base64: chunks.join('') };
    }
    chunks = [];
    renderOnce(id, pageIndex, targetWidthPx, input, 0, crop, nativePage);
  };

  post({ id: '__ready__', ok: true });
})();
</script>
</body>
</html>`;
}

/** A promise plus its resolver, for "the mode has been decided" signalling. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Mount this ONCE near the app root. It hosts the hidden offscreen WebView used
 * as the rendering engine and exposes the rasterize function via context.
 */
export const PdfRasterizerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const webviewRef = useRef<WebView>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const servedLoadRetryRef = useRef(false);
  const [engineGeneration, setEngineGeneration] = useState(0);
  const engineGenerationRef = useRef(0);
  const replaceEngine = useCallback(() => {
    // Invalidate native callbacks immediately, before React commits the new
    // WebView. A late ready ping must not dispatch into its unready successor.
    engineGenerationRef.current += 1;
    setEngineGeneration(engineGenerationRef.current);
  }, []);

  // The built page, kept so a served engine can fall back to inline.
  const htmlRef = useRef<string | null>(null);
  // Mirror of `engine` for event handlers; written only where the state is.
  const engineRef = useRef<Engine | null>(null);
  const applyEngine = useCallback((next: Engine) => {
    engineRef.current = next;
    setEngine(next);
  }, []);
  // The loopback origin PDFs are served from; null in inline mode. `settled`
  // resolves once that is known, so callers can wait for it.
  const originRef = useRef<string | null>(null);
  const settledRef = useRef(deferred());
  const leaseRef = useRef<LocalServerLease | null>(null);

  // Pending requests keyed by id, plus a FIFO queue so only one render runs at
  // a time (the single canvas/WebView is a shared resource).
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const queueRef = useRef<{ id: string; args: Required<RasterizeArgs> }[]>([]);
  const busyRef = useRef(false);
  const nativeActiveRef = useRef<string | null>(null);
  const verifiedGeometryRef = useRef(new Set<string>());
  const unsupportedRequestsRef = useRef(new Set<string>());
  const pumpQueueRef = useRef<() => void>(() => {});
  const mountedRef = useRef(true);
  const activeRequestRef = useRef<string | null>(null);
  const idCounterRef = useRef(0);

  // Load + inline the bundled pdf.js sources once (from the local asset files
  // only — no network access), then pick the engine: served if the loopback
  // server starts, inline otherwise.
  useEffect(() => {
    let cancelled = false;
    const settled = settledRef.current;
    (async () => {
      let html: string;
      try {
        const [mainAsset, workerAsset] = await Promise.all([
          Asset.fromModule(PDFJS_MAIN_ASSET).downloadAsync(),
          Asset.fromModule(PDFJS_WORKER_ASSET).downloadAsync(),
        ]);
        const mainUri = mainAsset.localUri ?? mainAsset.uri;
        const workerUri = workerAsset.localUri ?? workerAsset.uri;
        const [mainSource, workerSource] = await Promise.all([
          new File(mainUri).text(),
          new File(workerUri).text(),
        ]);
        html = buildHtml(mainSource, workerSource);
      } catch (err) {
        if (!cancelled) {
          // The WebView never mounts (engine stays null), so rasterize() calls
          // queue but cannot run; they reject via the per-request timeout.
          reportError(err, 'pdfjs-assets-load');
          console.error('PdfRasterizer: failed to load bundled pdf.js assets', err);
          settled.resolve();
        }
        return;
      }
      if (cancelled) return;
      htmlRef.current = html;

      try {
        const lease = await acquireLocalServer();
        if (cancelled) {
          await lease.release();
          return;
        }
        leaseRef.current = lease;
        // Rewritten on every mount: the served copy can never be older than
        // this code, and the hash in the URL defeats any WebView cache.
        writeServedText(RASTERIZER_PAGE_PATH, html);
        const pageUrl = servedFileUrl(lease.value, RASTERIZER_PAGE_PATH);
        if (pageUrl === null)
          throw new Error(`${RASTERIZER_PAGE_PATH} is not on the served allowlist`);
        originRef.current = lease.value;
        applyEngine({ kind: 'served', uri: `${pageUrl}?v=${fnv1a32(html)}` });
      } catch (err) {
        if (cancelled) return;
        // No server: the bridge path still works for small files. Reported,
        // because a big map will now fail with a message instead of drawing.
        reportError(err, 'pdf-rasterizer-server');
        console.error('PdfRasterizer: loopback server unavailable, using inline mode', err);
        originRef.current = null;
        applyEngine({ kind: 'inline', html });
      } finally {
        settled.resolve();
      }
    })();
    return () => {
      cancelled = true;
      originRef.current = null;
      settled.resolve();
      // StrictMode may restart setup on these refs. Its next startup needs a
      // fresh readiness promise, independent of this cancelled asset load.
      settledRef.current = deferred();
      const lease = leaseRef.current;
      leaseRef.current = null;
      lease?.release().catch(() => undefined);
    };
  }, [applyEngine]);

  const startNative = useCallback((id: string, pending: PendingRequest) => {
    if (nativeActiveRef.current !== null) return;
    const { nativePage, crop, pageIndex, targetWidthPx } = pending.args;
    if (!nativePage) return;
    const cacheKey = nativeGeometryKey(pending.args);
    const requestKey = nativeRequestKey(pending.args);
    nativeActiveRef.current = id;
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(pending.expire, RENDER_TIMEOUT_MS);
    let retryWithPdfJs = false;
    void (async () => {
      try {
        pending.backendDispatched = true;
        const result = await renderNativePdfCrop({
          fileUri: nativePage.fileUri,
          pageIndex,
          pageWidthPt: nativePage.expectedPageWidthPt,
          pageHeightPt: nativePage.expectedPageHeightPt,
          // Keep the public crop null for PDF.js's larger overview budget;
          // only the native API needs an explicit full-page rectangle.
          crop: crop ?? { x0: 0, y0: 0, x1: 1, y1: 1 },
          targetWidthPx,
        });
        if (
          !mountedRef.current ||
          pendingRef.current.get(id) !== pending ||
          activeRequestRef.current !== id
        ) {
          deleteNativePdfOutput(result.fileUri);
          return;
        }
        clearTimeout(pending.timeout);
        pendingRef.current.delete(id);
        if (cacheKey !== null) {
          const cache = verifiedGeometryRef.current;
          cache.delete(cacheKey);
          cache.add(cacheKey);
          while (cache.size > NATIVE_GEOMETRY_CACHE_LIMIT) {
            const oldest = cache.values().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
        pending.resolve(result);
      } catch (error) {
        if (cacheKey !== null) verifiedGeometryRef.current.delete(cacheKey);
        if (
          mountedRef.current &&
          pendingRef.current.get(id) === pending &&
          activeRequestRef.current === id &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'E_PDF_UNSUPPORTED'
        ) {
          // Unsupported can describe either the page encoding or this crop's
          // decoder budget. Cache only the exact crop and output width, never
          // disable valid small crops after a full-page request is refused.
          if (requestKey !== null) {
            const unsupported = unsupportedRequestsRef.current;
            unsupported.delete(requestKey);
            unsupported.add(requestKey);
            while (unsupported.size > NATIVE_GEOMETRY_CACHE_LIMIT) {
              const oldest = unsupported.values().next().value;
              if (oldest === undefined) break;
              unsupported.delete(oldest);
            }
          }
          // This page is outside the native renderer's deliberately narrow
          // capabilities. Retry the same request once without native handoff;
          // queue release in finally dispatches it ahead of waiting work.
          pending.args = { ...pending.args, nativePage: null };
          queueRef.current.unshift({ id, args: pending.args });
          retryWithPdfJs = true;
          return;
        }
        if (pendingRef.current.get(id) === pending) {
          clearTimeout(pending.timeout);
          pendingRef.current.delete(id);
          const admissionFailed =
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'E_PDF_BUSY' || error.code === 'E_PDF_CONTEXT');
          pending.reject(
            admissionFailed
              ? new PdfRenderNotStartedError(error)
              : error instanceof Error
                ? error
                : new Error(String(error)),
          );
        }
      } finally {
        if (!retryWithPdfJs) finishRecovery(pending);
        if (nativeActiveRef.current === id) {
          nativeActiveRef.current = null;
          if (mountedRef.current) {
            busyRef.current = false;
            activeRequestRef.current = null;
            pumpQueueRef.current();
          }
        }
      }
    })();
  }, []);

  const pumpQueue = useCallback(() => {
    if (busyRef.current || nativeActiveRef.current !== null || !readyRef.current) {
      return;
    }
    const next = queueRef.current.shift();
    if (!next) {
      return;
    }
    busyRef.current = true;
    const { id, args } = next;
    activeRequestRef.current = id;
    const cachedKey = nativeGeometryKey(args);
    const nativePending = pendingRef.current.get(id);
    if (nativePending?.recoveryPage && nativePending.recoveryToken === null) {
      try {
        // Persist only when this request actually owns the renderer, never
        // while queued. Keep identity independent of native eligibility.
        nativePending.recoveryToken = beginPdfRender(nativePending.recoveryPage);
      } catch (error) {
        clearTimeout(nativePending.timeout);
        pendingRef.current.delete(id);
        nativePending.reject(error instanceof Error ? error : new Error(String(error)));
        busyRef.current = false;
        activeRequestRef.current = null;
        pumpQueueRef.current();
        return;
      }
    }
    // Check at dispatch: an identical request may already be queued when
    // the first probe reports an unsupported encoding or decoder budget.
    const requestKey = nativeRequestKey(args);
    if (requestKey !== null && unsupportedRequestsRef.current.has(requestKey)) {
      unsupportedRequestsRef.current.delete(requestKey);
      unsupportedRequestsRef.current.add(requestKey);
      args.nativePage = null;
    } else if (cachedKey !== null && verifiedGeometryRef.current.has(cachedKey) && nativePending) {
      startNative(id, nativePending);
      return;
    }
    const wv = webviewRef.current;
    if (!wv) {
      busyRef.current = false;
      activeRequestRef.current = null;
      const pending = pendingRef.current.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRef.current.delete(id);
        finishRecovery(pending);
        pending.reject(new PdfRenderNotStartedError('PdfRasterizer: WebView unavailable'));
      }
      return;
    }

    // Returning `true` from injected JS is required by react-native-webview.
    const pending = pendingRef.current.get(id);
    if (pending) {
      pending.backendDispatched = true;
      // Queue/startup waiting is bounded separately from actual rendering.
      clearTimeout(pending.timeout);
      pending.timeout = setTimeout(pending.expire, RENDER_TIMEOUT_MS);
    }
    const idLiteral = JSON.stringify(id);
    const { source } = args;
    if (source.url !== undefined) {
      // Served: the request is four small values; pdf.js fetches the bytes.
      const urlLiteral = JSON.stringify(source.url);
      wv.injectJavaScript(
        `window.__pdfRender && window.__pdfRender(${idLiteral}, ${args.pageIndex}, ${args.targetWidthPx}, ${urlLiteral}, ${JSON.stringify(args.crop)}, ${JSON.stringify(args.nativePage)}); true;`,
      );
      return;
    }
    // Inline: reset, stream the base64 in chunks, then trigger the render.
    wv.injectJavaScript('window.__pdfReset && window.__pdfReset(); true;');
    for (let offset = 0; offset < source.base64.length; offset += BASE64_CHUNK_SIZE) {
      const chunk = source.base64.slice(offset, offset + BASE64_CHUNK_SIZE);
      const chunkLiteral = JSON.stringify(chunk);
      wv.injectJavaScript(`window.__pdfAppend && window.__pdfAppend(${chunkLiteral}); true;`);
    }
    wv.injectJavaScript(
      `window.__pdfRender && window.__pdfRender(${idLiteral}, ${args.pageIndex}, ${args.targetWidthPx}, null, ${JSON.stringify(args.crop)}, ${JSON.stringify(args.nativePage)}); true;`,
    );
  }, [startNative]);

  // Whenever the engine becomes ready (initial load or after a reload), drain
  // any queued requests.
  useEffect(() => {
    if (ready) {
      pumpQueue();
    }
  }, [ready, pumpQueue]);

  const finishCurrent = useCallback(() => {
    busyRef.current = false;
    activeRequestRef.current = null;
    pumpQueue();
  }, [pumpQueue]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: WebViewMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as WebViewMessage;
      } catch {
        return;
      }

      if (!isResultMessage(message)) {
        if (message.ok) {
          servedLoadRetryRef.current = false;
          readyRef.current = true;
          setReady(true);
        }
        return;
      }

      const pending = pendingRef.current.get(message.id);
      if (!pending || activeRequestRef.current !== message.id) {
        return;
      }
      if (message.ok && message.kind === 'native-geometry') {
        if (nativeActiveRef.current !== null) return;
        const { nativePage } = pending.args;
        if (
          !nativePage ||
          message.pageWidthPt !== nativePage.expectedPageWidthPt ||
          message.pageHeightPt !== nativePage.expectedPageHeightPt
        )
          return;
        startNative(message.id, pending);
        return;
      }
      // Once handed off, only the native promise owns this request.
      if (nativeActiveRef.current === message.id) return;
      clearTimeout(pending.timeout);
      pendingRef.current.delete(message.id);
      finishRecovery(pending);
      if (message.ok) {
        pending.resolve({
          pngDataUri: message.pngDataUri,
          widthPx: message.widthPx,
          heightPx: message.heightPx,
          pageWidthPt: message.pageWidthPt,
          pageHeightPt: message.pageHeightPt,
          pageCount: message.pageCount,
          loadMs: message.loadMs,
          renderMs: message.renderMs,
        });
      } else {
        pending.reject(new Error(message.error));
        if (message.resetEngine) {
          activeRequestRef.current = null;
          busyRef.current = false;
          readyRef.current = false;
          setReady(false);
          replaceEngine();
          return;
        }
      }
      finishCurrent();
    },
    [finishCurrent, startNative, replaceEngine],
  );

  // WKWebView/Android renderer death has its own event and need not emit a
  // page-load error. Replacing the native WebView revives an idle dead engine
  // too; waiting for an active request timeout leaves every queued map blocked.
  const handleProcessGone = useCallback(() => {
    readyRef.current = false;
    setReady(false);
    // A native crop does not belong to the WebView process. It must retain
    // the queue until its promise settles, even while the page is replaced.
    if (nativeActiveRef.current === null) {
      const id = activeRequestRef.current;
      const pending = id === null ? undefined : pendingRef.current.get(id);
      if (pending && id !== null) {
        clearTimeout(pending.timeout);
        pendingRef.current.delete(id);
        finishRecovery(pending);
        pending.reject(new Error('PdfRasterizer: rendering process terminated'));
      }
      activeRequestRef.current = null;
      busyRef.current = false;
    }
    replaceEngine();
  }, [replaceEngine]);

  // If the WebView process reloads/crashes, the engine is no longer ready and
  // must re-announce itself before we resume the queue.
  const handleLoadStart = useCallback(() => {
    readyRef.current = false;
    setReady(false);
  }, []);

  /**
   * The served page itself failed to load (server died, 403 from a wrong
   * allowlist, …): drop to inline mode so small maps still draw, and fail
   * every queued served request now rather than after its 45 s timeout —
   * the inline page cannot fetch their URLs.
   */
  const fallbackToInline = useCallback(
    (reason: string) => {
      const html = htmlRef.current;
      if (engineRef.current?.kind !== 'served' || html === null) return;
      reportError(
        new Error(`rasterizer page failed to load over loopback: ${reason}`),
        'pdf-rasterizer-server',
      );
      originRef.current = null;
      readyRef.current = false;
      setReady(false);
      applyEngine({ kind: 'inline', html });
      replaceEngine();
      // Replacing the WebView cannot stop PdfRenderer. Its completion still
      // owns queue release even when its caller is rejected below.
      if (nativeActiveRef.current === null) {
        busyRef.current = false;
        activeRequestRef.current = null;
      }
      // Requests that can still run on the inline page stay queued; every other
      // pending request — the in-flight one, and every queued URL request — is
      // rejected now.
      queueRef.current = queueRef.current.filter((q) => q.args.source.url === undefined);
      for (const [id, pending] of pendingRef.current) {
        if (queueRef.current.some((q) => q.id === id)) continue;
        clearTimeout(pending.timeout);
        pendingRef.current.delete(id);
        if (nativeActiveRef.current !== id) finishRecovery(pending);
        pending.reject(new Error(`PdfRasterizer: loopback server unavailable (${reason})`));
      }
    },
    [applyEngine, replaceEngine],
  );

  const handleError = useCallback(
    (event: WebViewErrorEvent) => {
      const { url, description } = event.nativeEvent;
      const current = engineRef.current;
      // Only the page's own load matters; a failed sub-request (a PDF that was
      // deleted, say) is reported to its caller by pdf.js.
      if (current?.kind === 'served' && (!url || current.uri.startsWith(url.split('?')[0] ?? ''))) {
        // A transient navigation failure does not prove the shared server died.
        // Retry this page once before losing URL access for the provider lifetime.
        // Successful readiness rearms the retry; repeated failures still fall
        // back to inline so small maps remain usable without a reload loop.
        if (!servedLoadRetryRef.current) {
          servedLoadRetryRef.current = true;
          handleProcessGone();
          return;
        }
        fallbackToInline(description || 'load error');
      }
    },
    [fallbackToInline, handleProcessGone],
  );

  const handleHttpError = useCallback(
    (event: WebViewHttpErrorEvent) => {
      const { url, statusCode } = event.nativeEvent;
      const current = engineRef.current;
      if (current?.kind === 'served' && url && current.uri.startsWith(url.split('?')[0] ?? '')) {
        fallbackToInline(`HTTP ${statusCode}`);
      }
    },
    [fallbackToInline],
  );

  // `rasterize` is stable (empty deps) but needs the latest pumpQueue; bridge
  // them through a ref so we don't recreate the public function on every render.
  useEffect(() => {
    pumpQueueRef.current = pumpQueue;
  }, [pumpQueue]);

  const rasterize = useCallback<RasterizeFn>(
    (args) => {
      return new Promise<RasterResult>((resolve, reject) => {
        if (!mountedRef.current) {
          reject(new Error('PdfRasterizer: provider unmounted'));
          return;
        }
        const { source } = args;
        if (source.url === undefined && !source.base64) {
          reject(new PdfRenderNotStartedError('PdfRasterizer: base64 is empty'));
          return;
        }
        if (source.url !== undefined && originRef.current === null) {
          // A URL can only be fetched by the served page; callers ask
          // `serverOrigin()` first, so this is a programming error, not a hang.
          reject(
            new PdfRenderNotStartedError(
              'PdfRasterizer: engine is in inline mode, cannot fetch a URL',
            ),
          );
          return;
        }
        idCounterRef.current += 1;
        const id = `req-${idCounterRef.current}`;
        const normalized: Required<RasterizeArgs> = {
          source,
          pageIndex: args.pageIndex,
          targetWidthPx: args.targetWidthPx ?? DEFAULT_TARGET_WIDTH_PX,
          crop: args.crop ?? null,
          nativePage: nativePdfAvailable() ? (args.nativePage ?? null) : null,
          priority: args.priority ?? 'interactive',
        };
        const expire = () => {
          const stillPending = pendingRef.current.get(id);
          if (stillPending) {
            pendingRef.current.delete(id);
            stillPending.reject(
              new Error(`PdfRasterizer: render timed out after ${RENDER_TIMEOUT_MS}ms`),
            );
            queueRef.current = queueRef.current.filter((queued) => queued.id !== id);
            if (nativeActiveRef.current === id) {
              const key = nativeGeometryKey(normalized);
              if (key !== null) verifiedGeometryRef.current.delete(key);
              // PdfRenderer cannot be interrupted by replacing a WebView. Keep
              // queue ownership until its promise settles; delete late output.
              return;
            }
            finishRecovery(stillPending);
            if (activeRequestRef.current === id) {
              // A timeout does not stop pdf.js. Destroy the old WebView/canvas
              // and wait for the replacement's ready message before proceeding.
              activeRequestRef.current = null;
              busyRef.current = false;
              readyRef.current = false;
              setReady(false);
              replaceEngine();
            } else if (!busyRef.current && !readyRef.current && engineRef.current !== null) {
              // Startup/reload can fail before any request owns the canvas. A
              // queued timeout must replace that non-ready engine too, otherwise
              // every future map waits against the same dead page forever.
              replaceEngine();
            } else {
              // Expiring a queued request must never release an active render.
              pumpQueueRef.current();
            }
          }
        };
        const timeout = setTimeout(expire, RENDER_TIMEOUT_MS);

        const pendingRequest: PendingRequest = {
          backendDispatched: false,
          args: normalized,
          recoveryPage: args.nativePage
            ? { fileUri: args.nativePage.fileUri, pageIndex: args.pageIndex }
            : null,
          recoveryToken: null,
          resolve,
          reject: (error) =>
            reject(pendingRequest.backendDispatched ? error : new PdfRenderNotStartedError(error)),
          timeout,
          expire,
        };
        pendingRef.current.set(id, pendingRequest);
        // Interactive work queues ahead of every waiting background pre-render
        // (but never ahead of other interactive work, and never displaces the
        // render in progress); background work always joins at the back.
        const queue = queueRef.current;
        const firstBackground =
          normalized.priority === 'background'
            ? -1
            : queue.findIndex((queued) => queued.args.priority === 'background');
        if (firstBackground === -1) queue.push({ id, args: normalized });
        else queue.splice(firstBackground, 0, { id, args: normalized });
        pumpQueueRef.current();
      });
    },
    [replaceEngine],
  );

  const serverOrigin = useCallback<ServerOriginFn>(async () => {
    while (mountedRef.current) {
      const settled = settledRef.current;
      await settled.promise;
      if (settled === settledRef.current) return originRef.current;
    }
    return null;
  }, []);

  // Reject everything still pending on unmount so callers never hang.
  useEffect(() => {
    const pending = pendingRef.current;
    const verifiedGeometry = verifiedGeometryRef.current;
    const unsupportedRequests = unsupportedRequestsRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pending.forEach((req, id) => {
        clearTimeout(req.timeout);
        if (nativeActiveRef.current !== id) finishRecovery(req);
        req.reject(new Error('PdfRasterizer: provider unmounted'));
      });
      pending.clear();
      verifiedGeometry.clear();
      unsupportedRequests.clear();
      // StrictMode can replay setup on these same refs. Discard abandoned JS
      // queue entries, but never release an unfinished native operation.
      queueRef.current = [];
      readyRef.current = false;
      if (nativeActiveRef.current === null) {
        busyRef.current = false;
        activeRequestRef.current = null;
      }
    };
  }, []);

  const contextValue = useMemo<RasterizerContextValue>(
    () => ({ rasterize, serverOrigin }),
    [rasterize, serverOrigin],
  );

  return (
    <PdfRasterizerContext.Provider value={contextValue}>
      {engine ? (
        <View style={styles.hidden} pointerEvents="none" collapsable={false}>
          <WebView
            key={engineGeneration}
            ref={webviewRef}
            source={engine.kind === 'served' ? { uri: engine.uri } : { html: engine.html }}
            originWhitelist={['*']}
            onMessage={(event) => {
              if (engineGeneration === engineGenerationRef.current) handleMessage(event);
            }}
            onLoadStart={() => {
              if (engineGeneration === engineGenerationRef.current) handleLoadStart();
            }}
            onContentProcessDidTerminate={() => {
              if (engineGeneration === engineGenerationRef.current) handleProcessGone();
            }}
            onRenderProcessGone={() => {
              if (engineGeneration === engineGenerationRef.current) handleProcessGone();
            }}
            onError={(event) => {
              if (engineGeneration === engineGenerationRef.current) handleError(event);
            }}
            onHttpError={(event) => {
              if (engineGeneration === engineGenerationRef.current) handleHttpError(event);
            }}
            javaScriptEnabled
            // Offline guarantee: the document is self-contained and only ever
            // talks to the app's own loopback server — nothing remote.
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            androidLayerType="software"
            // Avoid scaling/zoom affecting the offscreen canvas.
            scalesPageToFit={false}
            // Render bitmaps eagerly even while offscreen; never cache the page.
            cacheEnabled={false}
          />
        </View>
      ) : null}
      {children}
    </PdfRasterizerContext.Provider>
  );
};

function useRasterizerContext(): RasterizerContextValue {
  const ctx = useContext(PdfRasterizerContext);
  if (!ctx) {
    throw new Error('usePdfRasterizer must be used within a <PdfRasterizerProvider>');
  }
  return ctx;
}

/**
 * Returns a function that resolves with the rendered page. Calls are serialized
 * (one render at a time), with separate 45s queue/startup and active budgets.
 * `priority: 'background'` requests wait behind every interactive one.
 */
export function usePdfRasterizer(): RasterizeFn {
  return useRasterizerContext().rasterize;
}

/**
 * Returns a function resolving to the loopback origin PDFs can be served from
 * (`http://127.0.0.1:<port>`), or `null` when the engine had to fall back to
 * the inline bridge. Callers build `{ url }` sources only from a non-null origin.
 */
export function usePdfRasterizerServer(): ServerOriginFn {
  return useRasterizerContext().serverOrigin;
}

const styles = StyleSheet.create({
  // Keep the WebView mounted (so JS runs) but visually absent and 1x1 so it
  // never affects layout or paints onto the screen.
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    left: -1000,
    top: -1000,
  },
});
