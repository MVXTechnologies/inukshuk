import { PdfLoopbackUnavailableError, PdfRenderNotStartedError } from './pdfRenderFailure';
import { type PdfCrop } from '@core/geo/pdfDetail';
import { PDF_LAYER_RUNTIME_SOURCE } from '@core/geo/pdfLayers';
import { isPageLevelUnsupported, persistentNativeGeometryKey } from '@core/geo/nativePdfSupport';
import { PDF_RASTER_ROTATION } from '@core/geo/geopdf/orientation';
import {
  PDF_WHITE_KEY_RUNTIME_SOURCE,
  whiteKeyStrength,
  type WhiteKeyLevel,
} from '@core/geo/pdfWhiteKey';
import { patchPdfWorkerSource } from '@core/geo/pdfWorkerPatch';
import { PDFJS_POLYFILL_SOURCE } from '@core/geo/pdfjsPolyfills';
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
 * **Loopback liveness (iOS resume).** A suspended app's listening socket can
 * be reclaimed while lighttpd and the WebView page live on; every served
 * fetch is then refused ("Load failed", #381/#385). The server is probed on
 * return to the foreground, before served work after a long idle, after a
 * served transport failure and when the page itself fails to load; a dead
 * one is restarted (same port when possible) and the page reloaded, and the
 * request that hit the dead server is retried once. See
 * `@core/storage/loopbackLiveness` for the policy.
 *
 * See `PdfRasterizer.README.md` for the bundling/offline design and limitations.
 */
import { fnv1a32 } from '@core/encoding/fnv1a';
import {
  applyLoopbackSignal,
  isExpectedServerDeath,
  isServedTransportFailure,
  needsProbe,
  rebaseServedUrl,
  recoveryAfterFailedProbe,
  startedHealth,
  type LoopbackHealth,
  type LoopbackSignal,
  type VerifyReason,
} from '@core/storage/loopbackLiveness';
import {
  appPhaseAt,
  terminationMessage,
  terminationVerdict,
  type AppPhase,
  type AppPhaseInput,
} from '@core/library/processTermination';
import { servedFileUrl } from '@core/storage/servedPaths';
import {
  acquireLocalServer,
  probeLocalServer,
  restartLocalServer,
  writeServedText,
  type LocalServerLease,
  copyToServed,
} from '@data/localServer';
import { nativePdfAvailable, renderNativePdfCrop, deleteNativePdfOutput } from '@data/nativePdf';
import { beginPdfRender, finishPdfRender } from '@data/pdfRenderRecovery';
import { loadVerifiedNativePages, saveVerifiedNativePages } from '@data/nativePdfGeometry';
import { addBreadcrumb, reportError } from '@lib/errorReporting';
import { PDF_BENCH, pdfBenchEmit, pdfBenchId } from '@lib/pdfBenchProbe';
import { loadPdfjsSources, stagePdfjsFallbacks, type PdfjsSources } from './pdfjsAssets';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from 'react-native-webview/lib/WebViewTypes';

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
   * "See-through white" (`@core/geo/pdfWhiteKey`): after pdf.js paints, the
   * page's near-white paper is keyed to transparency at this level, in the
   * same WebView pass. `off` (default) leaves the render untouched. A tile
   * a native renderer drew is keyed by the page afterwards (`__pdfKeyImage`)
   * and comes back as `pngDataUri`, so keying does not cost the native path.
   */
  whiteKey?: WhiteKeyLevel;
  /**
   * Queue placement. `interactive` (default) is something the map is waiting
   * for and goes ahead of every queued `background` request; `background` is
   * the import-time pre-render (#272 step 2) and only runs once nothing
   * interactive is waiting. A render already in progress is never preempted.
   */
  priority?: RasterizePriority;
  /**
   * Served path only: requests that share this key (a page's file and
   * revision) may reuse the document the previous one opened, so a burst of
   * detail tiles opens and parses the page once instead of once per tile.
   * Empty (default) opens and releases the document per request.
   */
  holdKey?: string;
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
  /** Ms of the see-through-white pass (part of `renderMs`); absent when unkeyed. */
  keyMs?: number;
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
  keyMs?: number;
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
/** The page keyed a native tile's white (`__pdfKeyImage`). */
type WebViewKeyedMessage = { id: string; kind: 'keyed' } & (
  | { ok: true; pngDataUri: string; widthPx: number; heightPx: number; keyMs: number }
  | { ok: false; error: string }
);
type WebViewResultMessage = WebViewSuccessMessage | WebViewErrorMessage | WebViewNativeMessage;
type WebViewMessage = WebViewResultMessage | WebViewReadyMessage | WebViewKeyedMessage;

/** Where a native tile waits, on the served allowlist, for the page to key it. */
const KEY_STAGING_DIR = '.rasterizer';
/** Loading, keying and re-encoding one tile; far below the render timeout. */
const KEY_TIMEOUT_MS = 15_000;

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

/** The layer-plan code a persisted verification was made with (see below). */
const LAYER_PLAN_VERSION = fnv1a32(PDF_LAYER_RUNTIME_SOURCE);

/** A verification that outlives this launch: the page, not the served URL. */
function persistedGeometryKey(args: Required<RasterizeArgs>): string | null {
  const page = args.nativePage;
  return page
    ? persistentNativeGeometryKey(
        {
          fileUri: page.fileUri,
          revision: page.revision,
          pageIndex: args.pageIndex,
          widthPt: page.expectedPageWidthPt,
          heightPt: page.expectedPageHeightPt,
        },
        LAYER_PLAN_VERSION,
      )
    : null;
}

interface PendingRequest {
  backendDispatched: boolean;
  /** Re-queued once already after a served transport failure. */
  transportRetried: boolean;
  /**
   * Where the app was when the WebView content process died under this
   * request (it was re-queued once); null until that happens (#323).
   */
  processGone: AppPhase | null;
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
 * The page's Content-Security-Policy. pdf.js 6 has no eval path at all
 * (`scripts/pdfjs/assets.test.mjs` checks the shipped files), and this keeps
 * it that way at the engine level: without `'unsafe-eval'` no string can be
 * compiled as JavaScript on the page or in its worker, whatever a PDF holds —
 * the defence in depth `isEvalSupported: false` gave against CVE-2024-4367.
 * `'wasm-unsafe-eval'` lets the JPEG 2000 / JBIG2 decoders compile (iOS 16+,
 * Chrome 97+); `'unsafe-inline'` and `blob:` are the inlined scripts and the
 * worker. `connect-src` keeps fetches on the page's own origin (the loopback
 * server), so a script that did run could not send data off the device.
 */
export const RASTERIZER_PAGE_CSP =
  "script-src 'self' 'unsafe-inline' blob: 'wasm-unsafe-eval'; " +
  "connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'";

/**
 * Make text safe inside an inline `<script>` element: `</script` (any case)
 * would end the element early. `<\/` means the same as `</` inside a JS
 * string, template or regex, the only places that sequence can occur.
 */
export function scriptSafe(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Build the offscreen HTML document, inlining pdf.js 6 (`@/features/map/
 * pdfjsAssets`): the main module, the worker module (as a string, started as
 * a Blob module worker or evaluated on the page), and the wasm decoders.
 *
 * pdf.js 6 is ES modules only. The main build runs as an inline
 * `<script type="module">`, which is deferred: the page script below starts
 * once the document is parsed (`DOMContentLoaded`), when the module has run
 * and set `window.pdfjsLib` — or failed, which the page reports as not ready.
 */
export function buildHtml(sources: Omit<PdfjsSources, 'fallbacks'>): string {
  // The worker is patched to skip content hidden by optional content (#477:
  // a US Topo sheet's hidden orthoimage and shaded relief cost ~5 s of JPEG
  // decoding per render). Unpatchable sources (a different pdf.js build) run
  // stock: slower, never wrong. The polyfills go first: the worker is its
  // own global scope.
  const worker = patchPdfWorkerSource(sources.worker);
  if (!worker.patched && sources.worker.length > 0) {
    console.warn(
      `PdfRasterizer: pdf.js worker not patched (${worker.unmatched.join(', ')}); ` +
        'hidden PDF layers will still be decoded',
    );
  }
  const workerLiteral = scriptSafe(JSON.stringify(`${PDFJS_POLYFILL_SOURCE}\n;${worker.source}`));
  const wasmLiteral = JSON.stringify(sources.wasm);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${RASTERIZER_PAGE_CSP}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>html,body{margin:0;padding:0;background:#fff;}#stage{position:absolute;left:-99999px;top:0;}</style>
</head>
<body>
<div id="stage"><canvas id="canvas"></canvas></div>
<script>${PDFJS_POLYFILL_SOURCE}</script>
<script>${PDF_LAYER_RUNTIME_SOURCE}</script>
<script>${PDF_WHITE_KEY_RUNTIME_SOURCE}</script>
<script type="module">${scriptSafe(sources.main)}</script>
<script>
(function () {
  'use strict';
  var WORKER_SOURCE = ${workerLiteral};
  // True when the worker can drop hidden layer content (patched, #477).
  var WORKER_FILTERS_LAYERS = ${worker.patched ? 'true' : 'false'};
  // Aerial imagery stays off until there is a per-map switch for it (#477).
  var LAYER_PREFS = { showImagery: false };
  // The JPEG 2000 / JBIG2 decoders (base64), handed to pdf.js on request.
  var WASM = ${wasmLiteral};
  var HAS_WASM = typeof WebAssembly === 'object' && WebAssembly !== null &&
    typeof WebAssembly.instantiate === 'function';

  // Decide every optional-content group's visibility (document defaults plus
  // __inkPlanLayers' rules), apply it to the config pdf.js paints with, and
  // hand the same map to the worker so hidden images, shadings and forms are
  // never decoded. Resolves { config, changed }: config is null when the
  // document has no layers or they could not be read (pdf.js defaults apply).
  function prepareLayers(doc, loadingTask) {
    var none = { config: null, changed: 0, drawnChanged: 0 };
    var OPS = window.pdfjsLib.OPS || {};
    var ops = { paintXObject: OPS.paintXObject, endInlineImage: OPS.endInlineImage, shadingFill: OPS.shadingFill };
    function filterWorker(visibility) {
      if (!WORKER_FILTERS_LAYERS) return;
      // Same port as pdf.js' own messages, so it lands before the operator
      // list request. The fake (main-thread) worker shares this global.
      try {
        var port = loadingTask._worker && loadingTask._worker.port;
        if (port && typeof port.postMessage === 'function') {
          port.postMessage({ inukshukOptionalContent: visibility, inukshukOps: ops });
        }
      } catch (e) {}
      if (window.__inkOC) window.__inkOC.set(visibility, ops);
    }
    if (!doc || typeof doc.getOptionalContentConfig !== 'function' || typeof window.__inkPlanLayers !== 'function') {
      filterWorker(null);
      return Promise.resolve(none);
    }
    return doc.getOptionalContentConfig().then(function (config) {
      try {
        // pdf.js 6: the config iterates [id, group] pairs (3.11's getGroups()
        // is gone). An empty config means no layers.
        var list = [];
        if (config && typeof config[Symbol.iterator] === 'function') {
          var it = config[Symbol.iterator]();
          for (var step = it.next(); !step.done; step = it.next()) {
            var entry = step.value;
            if (entry && entry[1]) list.push({ id: String(entry[0]), name: entry[1].name, visible: !!entry[1].visible });
          }
        }
        if (list.length === 0) {
          filterWorker(null);
          return none;
        }
        var plan = window.__inkPlanLayers(list, LAYER_PREFS);
        // Paint config first, worker second: a failure in between leaves the
        // worker unfiltered, which is only slower, never wrong.
        plan.changed.forEach(function (id) { config.setVisibility(id, plan.visibility[id]); });
        filterWorker(plan.visibility);
        return { config: config, changed: plan.changed.length, drawnChanged: (plan.drawnChanged || plan.changed).length };
      } catch (e) {
        filterWorker(null);
        return none;
      }
    }, function () {
      filterWorker(null);
      return none;
    });
  }

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

  // Served-fetch trace (#331). WebKit reports every network failure inside
  // the page as a bare TypeError "Load failed" — no URL, no status, no byte
  // count — and that is all the auto-reports carried. Every fetch pdf.js makes
  // is recorded (path, Range, status, bytes read, failure) so a render error
  // can name the request that failed and how far the transfer got.
  var FETCH_TRACE_LIMIT = 4;
  var fetchTrace = [];
  var fetchCount = 0;
  var fetchFailures = 0;
  function resetFetchTrace() {
    fetchTrace = [];
    fetchCount = 0;
    fetchFailures = 0;
  }
  function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === name.toLowerCase()) return String(headers[keys[i]]);
    }
    return null;
  }
  function pathOf(url) {
    try { return new URL(String(url), window.location.href).pathname; } catch (e) { return String(url); }
  }
  function describeFetch(entry) {
    return 'GET ' + entry.path + (entry.range ? ' ' + entry.range : '') +
      (entry.status ? ' -> ' + entry.status : '') + ' (' + entry.bytes + ' B read)' +
      (entry.error ? ' failed: ' + entry.error : '');
  }
  // Appended to render errors once any fetch failed: which request, how far.
  function fetchSummary() {
    if (fetchFailures === 0) return '';
    var failed = null;
    for (var i = fetchTrace.length - 1; i >= 0 && !failed; i--) if (fetchTrace[i].error) failed = fetchTrace[i];
    return ' [served fetch: ' + fetchCount + ' requests, ' + fetchFailures + ' failed' +
      (failed ? '; ' + describeFetch(failed) : '') + ']';
  }
  function tracedFetch(nativeFetch) {
    return function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var entry = {
        path: pathOf(url),
        range: headerValue(init && init.headers, 'Range') || (input && input.headers ? headerValue(input.headers, 'Range') : null),
        status: 0, bytes: 0, error: null,
      };
      fetchCount += 1;
      fetchTrace.push(entry);
      if (fetchTrace.length > FETCH_TRACE_LIMIT) fetchTrace.shift();
      function fail(err) {
        entry.error = (err && err.message) ? err.message : String(err);
        fetchFailures += 1;
        throw err;
      }
      return nativeFetch.call(window, input, init).then(function (response) {
        entry.status = response.status;
        var body = response.body;
        if (body && typeof body.getReader === 'function') {
          try {
            var getReader = body.getReader.bind(body);
            body.getReader = function () {
              var reader = getReader();
              var read = reader.read.bind(reader);
              reader.read = function () {
                return read().then(function (result) {
                  if (result && result.value && result.value.byteLength) entry.bytes += result.value.byteLength;
                  return result;
                }, fail);
              };
              return reader;
            };
          } catch (e) {}
        }
        return response;
      }, fail);
    };
  }
  if (typeof window.fetch === 'function') window.fetch = tracedFetch(window.fetch);

  function base64ToBytes(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // pdf.js asks the page for its wasm decoders (useWorkerFetch: false) instead
  // of fetching them by URL, so JPEG 2000 and JBIG2 decode in served and
  // inline mode alike. Nothing else is bundled: standard fonts and CMaps fall
  // back as before, and ICC profiles are ignored (as with 3.11), which keeps
  // colours and timing unchanged.
  function InkBinaryDataFactory() {}
  InkBinaryDataFactory.prototype.fetch = function (request) {
    var kind = request && request.kind;
    var name = request && request.filename;
    if (kind === 'wasmUrl' && typeof name === 'string' && Object.prototype.hasOwnProperty.call(WASM, name) && WASM[name]) {
      try {
        return Promise.resolve(base64ToBytes(WASM[name]));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.reject(new Error('Unable to load ' + kind + ' data: ' + name + ' is not bundled'));
  };

  // pdf.js parses PDFs in a Web Worker: a same-origin Blob-URL module worker
  // built from the bundled source (fully offline).
  //
  // pdf.js's "fake worker" is NOT self-contained (#554): it runs the worker's
  // WorkerMessageHandler on this thread, which it takes from
  // window.pdfjsWorker or else imports from workerSrc — and it caches a
  // failure for the page's lifetime. useMainThreadWorker() evaluates the
  // bundled worker module into this page instead (an inline module script,
  // no URL at all) and resolves true once window.pdfjsWorker is defined.
  var MAIN_THREAD_WORKER_TIMEOUT_MS = 10000;
  var mainThreadWorker = null;
  function hasMainThreadWorker() {
    return !!(window.pdfjsWorker && window.pdfjsWorker.WorkerMessageHandler);
  }
  function useMainThreadWorker() {
    if (hasMainThreadWorker()) return Promise.resolve(true);
    if (mainThreadWorker) return mainThreadWorker;
    mainThreadWorker = new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('error', finish);
        window.__inkWorkerLoaded = undefined;
        resolve(hasMainThreadWorker());
      }
      timer = setTimeout(finish, MAIN_THREAD_WORKER_TIMEOUT_MS);
      // A module that throws while evaluating reports to window.onerror.
      window.addEventListener('error', finish);
      window.__inkWorkerLoaded = finish;
      try {
        var script = document.createElement('script');
        script.type = 'module';
        script.text = WORKER_SOURCE + '\\n;window.__inkWorkerLoaded && window.__inkWorkerLoaded();';
        (document.head || document.documentElement || document.body).appendChild(script);
      } catch (e) {
        finish();
      }
    }).then(function (ok) {
      // A failed attempt may be retried by the next request.
      if (!ok) mainThreadWorker = null;
      return ok;
    });
    return mainThreadWorker;
  }

  // Where the served page finds pdf.js' no-WebAssembly decoders (staged by
  // RN under .rasterizer/pdfjs/). Inline mode has no URL to give.
  var wasmUrl;
  // True when pdf.js must run on this thread (inline mode, or no Blob
  // worker): every render first makes sure the worker module is loaded.
  var mainThreadMode = false;

  // Incremental base64 assembly (inline mode) so multi-MB PDFs never exceed
  // bridge limits.
  var chunks = [];

  window.__pdfReset = function () {
    chunks = [];
  };
  window.__pdfAppend = function (chunk) {
    chunks.push(chunk);
  };

  // Watchdog: if pdf.js makes no progress opening the document within this
  // window, the real Blob worker has most likely wedged. We then force the
  // main-thread fake worker and retry exactly once, so a hostile WebView worker
  // can't hang us. "Progress" counts: on the served path a 200 MB sheet can
  // legitimately take longer than this to open (pdf.js may have to read a lot
  // of it to find the xref), but a live worker keeps requesting ranges, and
  // each range re-arms the watchdog. A wedged worker requests nothing.
  var LOAD_WATCHDOG_MS = 12000;
  // How long a stalled attempt's teardown may hold up the retry.
  var STALL_RELEASE_MS = 1000;
  var RANGE_CHUNK_BYTES = 1048576;

  // How the raster is finished after pdf.js paints: { whiteKey: strength }
  // keys near-white paper to transparency (0 or absent = untouched).
  function keyStrength(look) {
    var s = look && typeof look.whiteKey === 'number' ? look.whiteKey : 0;
    return s > 0 && typeof window.__inkKeyWhite === 'function' ? Math.min(1, s) : 0;
  }

  // The document a burst of detail tiles shares. Opening it, building the
  // page's operator list and decoding its images is most of a render — and
  // nearly independent of the crop: a US Topo sheet costs the same ~0.7 s for
  // a 1024 px tile as for the 2048 px overview. A tile request that names the
  // same hold key as the last one (same served URL and file revision) reuses
  // the open document and page, whose operator list pdf.js keeps, and only
  // paints. Released after HOLD_IDLE_MS without a matching request, on any
  // other request, on every failure, and when RN asks (__pdfDropHeld: the app
  // went to the background or the OS warned about memory). 30 s, not 8: a
  // person looks at a view for longer than 8 s, and the next pan then paid
  // the whole open again (iPhone 17 simulator, US Topo: ~0.9 s vs ~0.2 s).
  var HOLD_IDLE_MS = 30000;
  var held = null;
  function dropHeld() {
    if (!held) return;
    var h = held;
    held = null;
    clearTimeout(h.timer);
    Promise.resolve().then(function () { return h.task.destroy(); }).catch(function () {});
  }
  window.__pdfDropHeld = dropHeld;

  function renderOnce(id, pageIndex, targetWidthPx, input, attempt, crop, nativePage, look) {
    var holdKey = input.url && look && typeof look.hold === 'string' && look.hold ? look.hold : null;
    var reuse = null;
    if (attempt === 0 && holdKey && held && held.key === holdKey) {
      reuse = held;
      clearTimeout(reuse.timer);
      held = null;
    } else {
      dropHeld();
    }
    // Every open: the page's own wasm hand-off, never a worker fetch, and no
    // string evaluation (isEvalSupported is a no-op in pdf.js 6, which has no
    // eval path; it stays as a guard should a future build bring one back).
    var common = {
      isEvalSupported: false,
      disableFontFace: false,
      useWorkerFetch: false,
      BinaryDataFactory: InkBinaryDataFactory,
      useWasm: HAS_WASM,
    };
    if (wasmUrl) common.wasmUrl = wasmUrl;
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
      params = { data: bytes };
    }
    Object.keys(common).forEach(function (k) { params[k] = common[k]; });

    var t0 = Date.now();
    var loadingTask = reuse ? reuse.task : window.pdfjsLib.getDocument(params);
    var pages = reuse ? reuse.pages : {};
    var layersPromise = reuse ? reuse.layers : null;
    var destruction = null;
    function releaseDocument() {
      if (!destruction) destruction = Promise.resolve().then(function () { return loadingTask.destroy(); });
      return destruction;
    }
    // After a successful paint: keep the document for the next tile of the
    // same burst instead of destroying it (see HOLD_IDLE_MS).
    function finishDocument(doc) {
      if (!holdKey || destruction) return releaseDocument();
      dropHeld();
      held = { key: holdKey, task: loadingTask, doc: doc, pages: pages, layers: layersPromise, timer: null };
      held.timer = setTimeout(dropHeld, HOLD_IDLE_MS);
      return Promise.resolve();
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
      // pdf.js 6's loadingTask.destroy() first awaits the worker setup, which
      // a wedged worker never finishes: wait for it a moment, not forever.
      Promise.race([
        releaseDocument(),
        new Promise(function (resolve) { setTimeout(resolve, STALL_RELEASE_MS); }),
      ]).then(function () {
        if (attempt === 0) {
          // Drop to the main-thread fake worker and retry once. (Emptying
          // workerSrc, as this used to, makes pdf.js throw 'No
          // "GlobalWorkerOptions.workerSrc" specified' instead, #554.)
          return useMainThreadWorker().then(function (ok) {
            if (!ok) {
              post({ id: id, ok: false, error: 'pdf load stalled and the pdf.js worker could not run on the page' + fetchSummary() });
              return;
            }
            renderOnce(id, pageIndex, targetWidthPx, input, 1, crop, nativePage, look);
          });
        }
        post({ id: id, ok: false, error: 'pdf load stalled in both worker modes' + fetchSummary() });
      }, releaseFailure);
    }
    function armWatchdog() {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(onStall, LOAD_WATCHDOG_MS);
    }
    if (!reuse) {
      armWatchdog();
      loadingTask.onProgress = function () {
        if (!stalled && !loaded) armWatchdog();
      };
    }

    (reuse ? Promise.resolve(reuse.doc) : loadingTask.promise)
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
        if (!pages[pageNumber]) pages[pageNumber] = doc.getPage(pageNumber);
        if (!layersPromise) layersPromise = prepareLayers(doc, loadingTask);
        return Promise.all([pages[pageNumber], layersPromise]).then(function (loadedPage) {
          var page = loadedPage[0];
          var layers = loadedPage[1];
          // Always rasterize in the page's UNROTATED (MediaBox) coordinate space
          // by forcing rotation: 0 — overriding any /Rotate display flag. The
          // georeferencing (VP/Measure BBox + GPTS, and the LGIDict registration)
          // is defined in unrotated user space, so applying /Rotate here would
          // render the image rotated relative to its geo corners, making rotated
          // pages (e.g. a /Rotate 90 landscape sheet) appear flipped and stretched.
          var baseViewport = page.getViewport({ scale: 1, rotation: ${PDF_RASTER_ROTATION} });
          var pageWidthPt = baseViewport.width;
          var pageHeightPt = baseViewport.height;
          // Native renderers draw the document's default layers; a page whose
          // layer plan draws differently from them stays on pdf.js so every raster of it
          // (overview and detail tiles) shows the same layers. They cannot
          // key white either: RN sends a keyed native tile back through
          // __pdfKeyImage, so keying does not keep a page off them.
          var strength = keyStrength(look);
          if (nativePage && layers.drawnChanged === 0 && page.rotate === 0 && page.userUnit === 1 &&
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
          var viewport = page.getViewport({ scale: scale, rotation: ${PDF_RASTER_ROTATION} });
          var widthPx = geometry.widthPx;
          var heightPx = geometry.heightPx;

          var canvas = document.getElementById('canvas');
          canvas.width = widthPx;
          canvas.height = heightPx;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, widthPx, heightPx);

          var t1 = Date.now();
          var renderParams = { canvasContext: ctx, viewport: viewport, transform: [1, 0, 0, 1, geometry.offsetX, geometry.offsetY] };
          if (layers.config) renderParams.optionalContentConfigPromise = Promise.resolve(layers.config);
          return page.render(renderParams).promise.then(function () {
            var keyMs;
            if (strength > 0) {
              // One pass over the painted pixels: near-white paper becomes
              // transparent, colour and ink stay (@core/geo/pdfWhiteKey).
              var tk = Date.now();
              var image = ctx.getImageData(0, 0, widthPx, heightPx);
              window.__inkKeyWhite(image.data, strength);
              ctx.putImageData(image, 0, 0);
              image = null;
              keyMs = Date.now() - tk;
            }
            var pngDataUri = canvas.toDataURL('image/png');
            // Free the canvas memory before reporting back.
            canvas.width = 1;
            canvas.height = 1;
            var renderMs = Date.now() - t1;
            // Release the document (and, on the served path, its chunk buffer)
            // before the next request; the WebView is a long-lived process.
            // A tile burst holds it instead, briefly (finishDocument).
            return finishDocument(doc).then(function () {
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
                keyMs: keyMs,
                reused: reuse ? true : undefined,
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
          post({ id: id, ok: false, error: ((err && err.message) ? err.message : String(err)) + fetchSummary() });
        }, releaseFailure);
      });
  }

  // \`url\` is null in inline mode: the PDF was streamed in via __pdfAppend.
  // "See-through white" for a tile a native renderer drew: load its PNG
  // (staged same-origin by RN), run the same one-pass key as a pdf.js render,
  // and post the keyed PNG. Loading and re-encoding cost far less than
  // painting the page with pdf.js, which is what a keyed tile used to need.
  window.__pdfKeyImage = function (id, url, strength) {
    function fail(reason) { post({ id: id, kind: 'keyed', ok: false, error: reason }); }
    if (typeof window.__inkKeyWhite !== 'function') { fail('white-key runtime missing'); return; }
    var img = new Image();
    img.onerror = function () { fail('native tile failed to load'); };
    img.onload = function () {
      try {
        var canvas = document.getElementById('canvas');
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var t = Date.now();
        var image = ctx.getImageData(0, 0, w, h);
        window.__inkKeyWhite(image.data, Math.min(1, strength));
        ctx.putImageData(image, 0, 0);
        image = null;
        var keyMs = Date.now() - t;
        var pngDataUri = canvas.toDataURL('image/png');
        canvas.width = 1;
        canvas.height = 1;
        post({ id: id, kind: 'keyed', ok: true, pngDataUri: pngDataUri, widthPx: w, heightPx: h, keyMs: keyMs });
      } catch (e) {
        fail('white-key failed: ' + ((e && e.message) ? e.message : String(e)));
      }
    };
    img.src = url;
  };

  window.__pdfRender = function (id, pageIndex, targetWidthPx, url, crop, nativePage, look) {
    resetFetchTrace();
    var input;
    if (url) {
      input = { url: url };
    } else {
      input = { base64: chunks.join('') };
    }
    chunks = [];
    (mainThreadMode ? useMainThreadWorker() : Promise.resolve(true)).then(function (ok) {
      if (!ok) {
        post({ id: id, ok: false, error: 'the pdf.js worker could not run on the page' });
        return;
      }
      renderOnce(id, pageIndex, targetWidthPx, input, 0, crop, nativePage, look);
    }).catch(function (err) {
      // renderOnce throwing synchronously (pdf.js refusing its parameters,
      // say) must still answer RN, not leave the request to its timeout.
      post({ id: id, ok: false, error: 'render failed to start: ' + ((err && err.message) ? err.message : String(err)) });
    });
  };

  // pdf.js (an inline module script, so deferred) has run once the document
  // is parsed. Then pick the worker and tell RN the page is ready.
  var started = false;
  function start() {
    if (started) return;
    started = true;
    if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== 'function') {
      post({ id: '__ready__', ok: false, error: 'pdfjsLib failed to load' });
      return;
    }
    // Inline mode (no loopback server) loads this page as about:blank, an
    // opaque origin. pdf.js then cannot treat the blob URL as same-origin and
    // wraps it in a second blob that imports it — the path that left one
    // Android 11 phone failing every render (#554). Inline mode only takes
    // small files, so parse them on this (hidden) page's thread from the start.
    var opaqueOrigin = false;
    try {
      opaqueOrigin = window.location.origin === 'null' || /^(about|data):/.test(window.location.href);
    } catch (e) {}
    if (!opaqueOrigin) {
      try {
        wasmUrl = new URL('pdfjs/', window.location.href).href;
      } catch (e) {}
    }
    mainThreadMode = opaqueOrigin;
    if (!mainThreadMode) {
      try {
        // pdf.js starts it as a module worker ({ type: "module" }).
        var blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      } catch (e) {
        mainThreadMode = true;
      }
    }
    // Start loading it now; the first render waits for it.
    if (mainThreadMode) useMainThreadWorker();
    post({ id: '__ready__', ok: true });
  }
  if (window.pdfjsLib) start();
  else document.addEventListener('DOMContentLoaded', start);
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
  // Whether the server is known to accept connections, and the check in
  // flight, if any. Served dispatch waits while one runs.
  const healthRef = useRef<LoopbackHealth>(startedHealth(0));
  const verifyingRef = useRef<Promise<void> | null>(null);
  // Origins of servers replaced by a restart on a new port. A URL a caller
  // built on one before the restart is moved to the live origin at dispatch.
  const retiredOriginsRef = useRef(new Set<string>());
  const verifyServerRef = useRef<(reason: VerifyReason) => Promise<void>>(() => Promise.resolve());
  const signalHealth = useCallback((signal: LoopbackSignal) => {
    healthRef.current = applyLoopbackSignal(healthRef.current, signal, Date.now());
  }, []);

  // Pending requests keyed by id, plus a FIFO queue so only one render runs at
  // a time (the single canvas/WebView is a shared resource).
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const queueRef = useRef<{ id: string; args: Required<RasterizeArgs> }[]>([]);
  const busyRef = useRef(false);
  const nativeActiveRef = useRef<string | null>(null);
  const verifiedGeometryRef = useRef(new Set<string>());
  const unsupportedRequestsRef = useRef(new Set<string>());
  // Verifications from earlier launches: a verified page's crops go native
  // at once, even before the pdf.js page has loaded (a cold launch).
  const persistedGeometryRef = useRef<Set<string> | null>(null);
  const persistedGeometry = useCallback(() => {
    if (persistedGeometryRef.current === null)
      persistedGeometryRef.current = new Set(loadVerifiedNativePages());
    return persistedGeometryRef.current;
  }, []);
  /** Did a native renderer refuse this page itself (this launch or an earlier one)? */
  const refusedPage = useCallback(
    (args: Required<RasterizeArgs>) => {
      const key = nativeGeometryKey(args);
      if (key !== null && unsupportedPagesRef.current.has(key)) return true;
      const persisted = persistedGeometryKey(args);
      return persisted !== null && persistedGeometry().has(`U${persisted}`);
    },
    [persistedGeometry],
  );
  /** May this request go to the native renderer without the pdf.js page? */
  const nativeReady = useCallback(
    (args: Required<RasterizeArgs>) => {
      if (!args.nativePage || whiteKeyStrength(args.whiteKey) > 0) return false;
      const key = nativeGeometryKey(args);
      if (key === null || refusedPage(args)) return false;
      const requestKey = nativeRequestKey(args);
      if (requestKey !== null && unsupportedRequestsRef.current.has(requestKey)) return false;
      if (verifiedGeometryRef.current.has(key)) return true;
      const persisted = persistedGeometryKey(args);
      return persisted !== null && persistedGeometry().has(persisted);
    },
    [persistedGeometry, refusedPage],
  );
  // Pages (geometry keys) a native renderer refused for the page itself: their
  // crops go straight to pdf.js (`@core/geo/nativePdfSupport`).
  const unsupportedPagesRef = useRef(new Set<string>());
  const pumpQueueRef = useRef<() => void>(() => {});
  const mountedRef = useRef(true);
  const activeRequestRef = useRef<string | null>(null);
  const idCounterRef = useRef(0);
  // Where the app is, for a content-process termination's verdict (#323):
  // in front, and since when (null: it has not left the foreground).
  const appPhaseRef = useRef<AppPhaseInput>({
    foreground: AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
    activeSince: null,
  });

  // Load + inline the bundled pdf.js sources once (from the local asset files
  // only — no network access), then pick the engine: served if the loopback
  // server starts, inline otherwise.
  useEffect(() => {
    let cancelled = false;
    const settled = settledRef.current;
    (async () => {
      let html: string;
      let fallbacks: PdfjsSources['fallbacks'];
      try {
        const sources = await loadPdfjsSources();
        fallbacks = sources.fallbacks;
        html = buildHtml(sources);
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
        // The no-WebAssembly decoders next to it, in the background: only a
        // WebView without WebAssembly needs them, so the page does not wait
        // for the copy, and a failed one is reported, not fatal.
        stagePdfjsFallbacks(fallbacks).catch((err: unknown) =>
          reportError(err, 'pdfjs-fallbacks-stage'),
        );
        const pageUrl = servedFileUrl(lease.value, RASTERIZER_PAGE_PATH);
        if (pageUrl === null)
          throw new Error(`${RASTERIZER_PAGE_PATH} is not on the served allowlist`);
        originRef.current = lease.value;
        healthRef.current = startedHealth(Date.now());
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

  // Native tiles waiting for the page to key their white, by request id.
  const keyWaitersRef = useRef(new Map<string, (message: WebViewKeyedMessage | null) => void>());
  /**
   * Key a native tile's white in the page: stage the PNG where the page can
   * load it, have it keyed, and return the keyed PNG. The native file and its
   * staged copy are deleted either way. Throws when the page cannot do it.
   */
  const keyNativeTile = useCallback(async (id: string, nativeUri: string, strength: number) => {
    const origin = originRef.current;
    const stagedPath = `${KEY_STAGING_DIR}/key-${id}.png`;
    let stagedUri: string | null = null;
    try {
      const url = origin === null ? null : servedFileUrl(origin, stagedPath);
      const wv = webviewRef.current;
      if (url === null || !wv || !readyRef.current) throw new Error('white-key page unavailable');
      stagedUri = await copyToServed(nativeUri, stagedPath);
      const message = await new Promise<WebViewKeyedMessage | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), KEY_TIMEOUT_MS);
        keyWaitersRef.current.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        wv.injectJavaScript(
          `window.__pdfKeyImage && window.__pdfKeyImage(${JSON.stringify(id)}, ${JSON.stringify(url)}, ${strength}); true;`,
        );
      });
      if (message === null) throw new Error('white-key timed out');
      if (!message.ok) throw new Error(message.error);
      return message;
    } finally {
      keyWaitersRef.current.delete(id);
      deleteNativePdfOutput(nativeUri);
      if (stagedUri !== null) deleteNativePdfOutput(stagedUri);
    }
  }, []);

  const startNative = useCallback(
    (id: string, pending: PendingRequest) => {
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
          // "See-through white": the native renderers cannot key, so the page
          // keys the tile they drew. A page that cannot (reloading, timed out)
          // sends this one crop back through pdf.js, which keys as it paints.
          const strength = whiteKeyStrength(pending.args.whiteKey);
          let keyed: (WebViewKeyedMessage & { ok: true }) | null = null;
          if (strength > 0) {
            try {
              keyed = await keyNativeTile(id, result.fileUri, strength);
            } catch {
              throw Object.assign(new Error('native tile could not be keyed'), {
                code: 'E_PDF_UNSUPPORTED',
              });
            }
            if (
              !mountedRef.current ||
              pendingRef.current.get(id) !== pending ||
              activeRequestRef.current !== id
            )
              return;
          }
          clearTimeout(pending.timeout);
          pendingRef.current.delete(id);
          const persisted = persistedGeometryKey(pending.args);
          if (persisted !== null) {
            // Same bound and recency order as the in-memory cache.
            const set = persistedGeometry();
            const known = set.delete(persisted);
            set.add(persisted);
            while (set.size > NATIVE_GEOMETRY_CACHE_LIMIT) {
              const oldest = set.values().next().value;
              if (oldest === undefined) break;
              set.delete(oldest);
            }
            if (!known) saveVerifiedNativePages([...set]);
          }
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
          if (keyed) {
            pending.resolve({
              pngDataUri: keyed.pngDataUri,
              widthPx: keyed.widthPx,
              heightPx: keyed.heightPx,
              pageWidthPt: result.pageWidthPt,
              pageHeightPt: result.pageHeightPt,
              pageCount: result.pageCount,
              loadMs: result.loadMs,
              renderMs: result.renderMs,
              keyMs: keyed.keyMs,
            });
          } else {
            pending.resolve(result);
          }
        } catch (error) {
          if (cacheKey !== null) verifiedGeometryRef.current.delete(cacheKey);
          const persisted = persistedGeometryKey(pending.args);
          if (persisted !== null && persistedGeometry().delete(persisted))
            saveVerifiedNativePages([...persistedGeometry()]);
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
            const reason = error instanceof Error ? error.message : String(error);
            if (cacheKey !== null && isPageLevelUnsupported(reason)) {
              // Remembered across launches too: on iOS every vector page is
              // refused, and the first crop after a launch would otherwise
              // open the page in pdf.js twice.
              const persisted = persistedGeometryKey(pending.args);
              if (persisted !== null && !persistedGeometry().has(`U${persisted}`)) {
                const set = persistedGeometry();
                set.add(`U${persisted}`);
                // The same bound as the in-memory refusals, oldest first.
                const refusals = [...set].filter((k) => k.startsWith('U'));
                for (const old of refusals.slice(0, -NATIVE_GEOMETRY_CACHE_LIMIT)) set.delete(old);
                saveVerifiedNativePages([...set]);
              }
              const pages = unsupportedPagesRef.current;
              pages.delete(cacheKey);
              pages.add(cacheKey);
              while (pages.size > NATIVE_GEOMETRY_CACHE_LIMIT) {
                const oldest = pages.values().next().value;
                if (oldest === undefined) break;
                pages.delete(oldest);
              }
            }
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
    },
    [keyNativeTile, persistedGeometry],
  );

  const pumpQueue = useCallback(() => {
    if (busyRef.current || nativeActiveRef.current !== null) return;
    // The pdf.js page is only needed for pdf.js work and first verifications:
    // a crop of a verified page goes native even while the page loads.
    const first = queueRef.current[0];
    if (!readyRef.current && !(first && nativeReady(first.args))) return;
    // A liveness check pumps again when it is done.
    if (verifyingRef.current !== null) return;
    const head = queueRef.current[0];
    if (
      head?.args.source.url !== undefined &&
      engineRef.current?.kind === 'served' &&
      needsProbe(healthRef.current, Date.now())
    ) {
      // Served work after a long idle, or with the server under suspicion:
      // prove it alive first rather than fail this request on a dead port.
      void verifyServerRef.current('idle');
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
    if (cachedKey !== null && refusedPage(args)) {
      args.nativePage = null;
    } else if (requestKey !== null && unsupportedRequestsRef.current.has(requestKey)) {
      unsupportedRequestsRef.current.delete(requestKey);
      unsupportedRequestsRef.current.add(requestKey);
      args.nativePage = null;
    } else if (cachedKey !== null && nativePending && nativeReady(args)) {
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
    const lookLiteral = JSON.stringify({
      whiteKey: whiteKeyStrength(args.whiteKey),
      ...(args.holdKey ? { hold: args.holdKey } : {}),
    });
    const live = originRef.current;
    if (args.source.url !== undefined && live !== null) {
      let url = args.source.url;
      for (const retired of retiredOriginsRef.current) url = rebaseServedUrl(url, retired, live);
      if (url !== args.source.url) args.source = { url };
    }
    const { source } = args;
    if (source.url !== undefined) {
      // Served: the request is four small values; pdf.js fetches the bytes.
      const urlLiteral = JSON.stringify(source.url);
      wv.injectJavaScript(
        `window.__pdfRender && window.__pdfRender(${idLiteral}, ${args.pageIndex}, ${args.targetWidthPx}, ${urlLiteral}, ${JSON.stringify(args.crop)}, ${JSON.stringify(args.nativePage)}, ${lookLiteral}); true;`,
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
      `window.__pdfRender && window.__pdfRender(${idLiteral}, ${args.pageIndex}, ${args.targetWidthPx}, null, ${JSON.stringify(args.crop)}, ${JSON.stringify(args.nativePage)}, ${lookLiteral}); true;`,
    );
  }, [startNative, nativeReady, refusedPage]);

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

      if ('kind' in message && message.kind === 'keyed') {
        keyWaitersRef.current.get(message.id)?.(message);
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
      if (
        !message.ok &&
        pending.args.source.url !== undefined &&
        isServedTransportFailure(message.error)
      ) {
        // The server refused or dropped the connection: nothing is known
        // about the page. Retry once behind a liveness check (which restarts
        // a dead server); a second transport failure is still not the page's
        // fault, so it rejects as "not started" and the page is not paused.
        signalHealth({ kind: 'unreachable' });
        activeRequestRef.current = null;
        busyRef.current = false;
        if (!pending.transportRetried) {
          pending.transportRetried = true;
          queueRef.current.unshift({ id: message.id, args: pending.args });
        } else {
          clearTimeout(pending.timeout);
          pendingRef.current.delete(message.id);
          finishRecovery(pending);
          pending.reject(new PdfLoopbackUnavailableError(message.error));
        }
        void verifyServerRef.current('transport');
        return;
      }
      clearTimeout(pending.timeout);
      pendingRef.current.delete(message.id);
      finishRecovery(pending);
      if (message.ok) {
        if (pending.args.source.url !== undefined) signalHealth({ kind: 'reachable' });
        pending.resolve({
          pngDataUri: message.pngDataUri,
          widthPx: message.widthPx,
          heightPx: message.heightPx,
          pageWidthPt: message.pageWidthPt,
          pageHeightPt: message.pageHeightPt,
          pageCount: message.pageCount,
          loadMs: message.loadMs,
          renderMs: message.renderMs,
          ...(typeof message.keyMs === 'number' ? { keyMs: message.keyMs } : {}),
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
    [finishCurrent, startNative, replaceEngine, signalHealth],
  );

  // WKWebView/Android renderer death has its own event and need not emit a
  // page-load error. Replacing the native WebView revives an idle dead engine
  // too; waiting for an active request timeout leaves every queued map blocked.
  //
  // #323: the OS also reclaims that process for reasons that are not the
  // page's (the app in the background, memory tight elsewhere), so the render
  // in flight is re-queued once; only a second termination of the same render
  // with the app in front fails the page (see @core/library/processTermination).
  const handleProcessGone = useCallback(() => {
    readyRef.current = false;
    setReady(false);
    // A native crop does not belong to the WebView process. It must retain
    // the queue until its promise settles, even while the page is replaced.
    if (nativeActiveRef.current === null) {
      const id = activeRequestRef.current;
      const pending = id === null ? undefined : pendingRef.current.get(id);
      if (pending && id !== null) {
        const phase = appPhaseAt(appPhaseRef.current, Date.now());
        const firstPhase = pending.processGone;
        const verdict = terminationVerdict(phase, firstPhase);
        if (verdict === 'retry') {
          // Back to the head of the queue; the replaced engine runs it again
          // once ready. Its crash-recovery checkpoint stays: same render.
          pending.processGone = phase;
          console.warn(
            `PdfRasterizer: rendering process terminated (app ${phase}); retrying ${id}`,
          );
          queueRef.current.unshift({ id, args: pending.args });
        } else {
          clearTimeout(pending.timeout);
          pendingRef.current.delete(id);
          finishRecovery(pending);
          const message = terminationMessage(firstPhase ?? phase, phase);
          pending.reject(
            verdict === 'page-failure' ? new Error(message) : new PdfRenderNotStartedError(message),
          );
        }
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
   * The served page failed to load twice (403 from a wrong allowlist, …), or
   * the server could not be brought back: drop to inline mode so small maps
   * still draw, and fail every queued served request now rather than after
   * its 45 s timeout — the inline page cannot fetch their URLs. `summary`
   * prefixes the report; `null` when the cause was already reported.
   */
  const fallbackToInline = useCallback(
    (reason: string, summary: string | null = 'rasterizer page failed to load over loopback') => {
      const html = htmlRef.current;
      if (engineRef.current?.kind !== 'served' || html === null) return;
      if (summary !== null) {
        reportError(new Error(`${summary}: ${reason}`), 'pdf-rasterizer-server');
      }
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
        // The server is gone, not the page: never a reason to pause it.
        pending.reject(
          new PdfLoopbackUnavailableError(`PdfRasterizer: loopback server unavailable (${reason})`),
        );
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
          readyRef.current = false;
          setReady(false);
          // "Could not connect to the server" after a resume is a dead
          // listener (#381, #385): probe, restart it if needed, reload the page.
          void verifyServerRef.current('page-load');
          return;
        }
        fallbackToInline(description || 'load error');
      }
    },
    [fallbackToInline],
  );

  /**
   * Point the engine at `origin` and load a fresh page from it. The pdf.js
   * request in flight (if any) goes back to the head of the queue instead of
   * failing — its server died, not its page — and every queued served URL
   * moves to the new origin. A native crop keeps the queue until it settles.
   */
  const reloadServedEngine = useCallback(
    (origin: string) => {
      const html = htmlRef.current;
      const pageUrl = servedFileUrl(origin, RASTERIZER_PAGE_PATH);
      if (html === null || pageUrl === null) return;
      const previous = originRef.current;
      originRef.current = origin;
      readyRef.current = false;
      setReady(false);
      if (nativeActiveRef.current === null) {
        const id = activeRequestRef.current;
        const active = id === null ? undefined : pendingRef.current.get(id);
        if (active && id !== null) queueRef.current.unshift({ id, args: active.args });
        activeRequestRef.current = null;
        busyRef.current = false;
      }
      if (previous !== null && previous !== origin) {
        retiredOriginsRef.current.add(previous);
        retiredOriginsRef.current.delete(origin);
        const rebase = (args: Required<RasterizeArgs>) => {
          if (args.source.url !== undefined) {
            args.source = { url: rebaseServedUrl(args.source.url, previous, origin) };
          }
        };
        queueRef.current.forEach((queued) => rebase(queued.args));
        pendingRef.current.forEach((pending) => rebase(pending.args));
      }
      applyEngine({ kind: 'served', uri: `${pageUrl}?v=${fnv1a32(html)}` });
      replaceEngine();
    },
    [applyEngine, replaceEngine],
  );

  /**
   * Prove the loopback server alive, or bring it back. Single-flight; while
   * it runs, `serverOrigin()` waits and nothing is dispatched. Outcomes:
   * alive → carry on (reloading the page only when it failed to load, or to
   * leave inline mode); dead → restart it and reload the page from it; out
   * of restarts, or the restart failed → inline mode, as before.
   */
  const verifyServer = useCallback(
    (reason: VerifyReason): Promise<void> => {
      if (verifyingRef.current !== null) return verifyingRef.current;
      const lease = leaseRef.current;
      if (lease === null || htmlRef.current === null || !mountedRef.current) {
        return Promise.resolve();
      }
      const gate = deferred();
      settledRef.current = gate;
      const staleOrigin = lease.value;
      const run = (async () => {
        let origin = staleOrigin;
        if (await probeLocalServer(staleOrigin)) {
          signalHealth({ kind: 'reachable' });
        } else {
          signalHealth({ kind: 'unreachable' });
          if (!mountedRef.current) return;
          if (recoveryAfterFailedProbe(healthRef.current, Date.now()) === 'give-up') {
            fallbackToInline(reason, 'loopback server unreachable, restart budget spent');
            return;
          }
          origin = await restartLocalServer(staleOrigin);
          signalHealth({ kind: 'restarted' });
          const restarted =
            `Loopback server was unreachable (${reason}); restarted on ` +
            `${origin === staleOrigin ? 'the same' : 'a new'} port`;
          // iOS reclaiming a suspended app's listener is documented and now
          // confirmed in the field (#582): a breadcrumb for context, not a
          // report. Any other death is still unexplained: report it.
          if (isExpectedServerDeath(reason, Platform.OS)) addBreadcrumb(restarted);
          else reportError(new Error(restarted), 'pdf-rasterizer-server-restart');
        }
        if (!mountedRef.current || leaseRef.current !== lease) return;
        if (
          engineRef.current?.kind !== 'served' ||
          origin !== originRef.current ||
          reason === 'page-load'
        ) {
          reloadServedEngine(origin);
        }
      })()
        .catch((error: unknown) => {
          // Restart failed (or the probe threw): lose URL rendering, keep inline.
          reportError(error, 'pdf-rasterizer-server');
          if (mountedRef.current) {
            fallbackToInline(error instanceof Error ? error.message : String(error), null);
          }
        })
        .finally(() => {
          verifyingRef.current = null;
          gate.resolve();
          pumpQueueRef.current();
        });
      verifyingRef.current = run;
      return run;
    },
    [fallbackToInline, reloadServedEngine, signalHealth],
  );
  useEffect(() => {
    verifyServerRef.current = verifyServer;
  }, [verifyServer]);

  // Resume: iOS may have reclaimed the listener while the app was suspended.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') appPhaseRef.current = { ...appPhaseRef.current, foreground: false };
      if (state === 'background') {
        signalHealth({ kind: 'background' });
        // A held document (parsed page, decoded images) is memory the OS
        // may reclaim the app for while it is suspended.
        if (readyRef.current)
          webviewRef.current?.injectJavaScript(
            'window.__pdfDropHeld && window.__pdfDropHeld(); true;',
          );
        return;
      }
      if (state !== 'active') return;
      if (!appPhaseRef.current.foreground) {
        appPhaseRef.current = { foreground: true, activeSince: Date.now() };
      }
      const returning = healthRef.current.backgroundedAt !== null;
      signalHealth({ kind: 'foreground' });
      if (returning) void verifyServerRef.current('resume');
    });
    const memory = AppState.addEventListener('memoryWarning', () => {
      if (readyRef.current)
        webviewRef.current?.injectJavaScript(
          'window.__pdfDropHeld && window.__pdfDropHeld(); true;',
        );
    });
    return () => {
      subscription.remove();
      memory.remove();
    };
  }, [signalHealth]);

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

  const enqueue = useCallback<RasterizeFn>(
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
        const whiteKey = args.whiteKey ?? 0;
        const normalized: Required<RasterizeArgs> = {
          source,
          pageIndex: args.pageIndex,
          targetWidthPx: args.targetWidthPx ?? DEFAULT_TARGET_WIDTH_PX,
          crop: args.crop ?? null,
          // Native renderers cannot key white; the served page keys their
          // tile afterwards. Inline mode has no way to hand it over: pdf.js.
          nativePage:
            nativePdfAvailable() && (whiteKey === 0 || originRef.current !== null)
              ? (args.nativePage ?? null)
              : null,
          whiteKey,
          priority: args.priority ?? 'interactive',
          holdKey: args.holdKey ?? '',
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
              const persisted = persistedGeometryKey(normalized);
              if (persisted !== null && persistedGeometry().delete(persisted))
                saveVerifiedNativePages([...persistedGeometry()]);
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
          transportRetried: false,
          processGone: null,
          args: normalized,
          recoveryPage: args.nativePage
            ? { fileUri: args.nativePage.fileUri, pageIndex: args.pageIndex }
            : null,
          recoveryToken: null,
          resolve,
          reject: (error) =>
            reject(
              pendingRequest.backendDispatched || error instanceof PdfRenderNotStartedError
                ? error
                : new PdfRenderNotStartedError(error),
            ),
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
    [replaceEngine, persistedGeometry],
  );

  const rasterize = useCallback<RasterizeFn>(
    (args) => {
      if (!PDF_BENCH) return enqueue(args);
      const id = pdfBenchId();
      const at = Date.now();
      pdfBenchEmit({
        kind: 'raster-start',
        id,
        at,
        priority: args.priority ?? 'interactive',
        targetWidthPx: args.targetWidthPx ?? DEFAULT_TARGET_WIDTH_PX,
        crop: !!args.crop,
        native: !!args.nativePage,
      });
      return enqueue(args).then(
        (result) => {
          pdfBenchEmit({
            kind: 'raster-end',
            id,
            at: Date.now(),
            ok: true,
            ms: Date.now() - at,
            path: result.fileUri !== undefined ? 'file' : 'data',
            loadMs: result.loadMs,
            renderMs: result.renderMs,
            widthPx: result.widthPx,
            heightPx: result.heightPx,
          });
          return result;
        },
        (error: unknown) => {
          pdfBenchEmit({
            kind: 'raster-end',
            id,
            at: Date.now(),
            ok: false,
            ms: Date.now() - at,
            path: 'data',
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      );
    },
    [enqueue],
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
    const unsupportedPages = unsupportedPagesRef.current;
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
      unsupportedPages.clear();
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
