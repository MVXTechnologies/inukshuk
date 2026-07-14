/**
 * PdfRasterizer — fully-offline PDF page → PNG rasterizer for MapLibre overlays.
 *
 * A single hidden offscreen `WebView` (mounted once by `PdfRasterizerProvider`)
 * acts as the rendering engine. The WebView hosts a self-contained HTML document
 * with the pdf.js *legacy UMD* build inlined from app-bundled assets — it never
 * touches the network. React Native drives it over the WebView message bridge:
 * RN injects the base64 PDF + render request, the page renders to an offscreen
 * `<canvas>`, and posts the resulting PNG data URI back.
 *
 * See `PdfRasterizer.README.md` for the bundling/offline design and limitations.
 */
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
 */
const RENDER_TIMEOUT_MS = 45_000;

/** Default target raster width in CSS px when the caller does not specify one. */
const DEFAULT_TARGET_WIDTH_PX = 2048;

/** Max base64 characters injected per chunk to stay under bridge size limits. */
const BASE64_CHUNK_SIZE = 256 * 1024;

export interface RasterizeArgs {
  /** PDF file contents as base64 (no data: prefix). */
  base64: string;
  /** 0-based page index to render. */
  pageIndex: number;
  /** Target render width in CSS px; height derived from page aspect. Default 2048. */
  targetWidthPx?: number;
}

export interface RasterResult {
  /** PNG image as a data URI ("data:image/png;base64,...") ready for MapLibre ImageSource.url. */
  pngDataUri: string;
  /** Rendered raster size in pixels. */
  widthPx: number;
  heightPx: number;
  /** The page's intrinsic size in PDF points (1/72 inch). */
  pageWidthPt: number;
  pageHeightPt: number;
  /** Total pages in the document. */
  pageCount: number;
}

/** Shape of the success/error messages the WebView posts back to RN. */
interface WebViewSuccessMessage {
  id: string;
  ok: true;
  pngDataUri: string;
  widthPx: number;
  heightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
  pageCount: number;
}
interface WebViewErrorMessage {
  id: string;
  ok: false;
  error: string;
}
interface WebViewReadyMessage {
  id: '__ready__';
  ok: boolean;
}
type WebViewResultMessage = WebViewSuccessMessage | WebViewErrorMessage;
type WebViewMessage = WebViewResultMessage | WebViewReadyMessage;

/** True for render-result messages (everything that is not the readiness ping). */
function isResultMessage(message: WebViewMessage): message is WebViewResultMessage {
  return message.id !== '__ready__';
}

interface PendingRequest {
  resolve: (result: RasterResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type RasterizeFn = (args: RasterizeArgs) => Promise<RasterResult>;

const PdfRasterizerContext = createContext<RasterizeFn | null>(null);

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

  // Incremental base64 assembly so multi-MB PDFs never exceed bridge limits.
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

  // Watchdog: if pdf.js can't even load the document within this window, the
  // real Blob worker has most likely wedged. We then force the main-thread fake
  // worker and retry exactly once, so a hostile WebView worker can't hang us.
  var LOAD_WATCHDOG_MS = 12000;

  function renderOnce(id, pageIndex, targetWidthPx, base64, attempt) {
    var bytes;
    try {
      // Decode fresh each attempt: getDocument may transfer/detach the buffer.
      bytes = base64ToBytes(base64);
    } catch (e) {
      post({ id: id, ok: false, error: 'base64 decode failed: ' + (e && e.message) });
      return;
    }

    var loadingTask = window.pdfjsLib.getDocument({
      data: bytes,
      isEvalSupported: false,
      disableFontFace: false,
    });

    var settled = false;
    var watchdog = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { loadingTask.destroy(); } catch (e) {}
      if (attempt === 0) {
        // Drop to the main-thread fake worker and retry once.
        try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = ''; } catch (e) {}
        renderOnce(id, pageIndex, targetWidthPx, base64, 1);
      } else {
        post({ id: id, ok: false, error: 'pdf load stalled in both worker modes' });
      }
    }, LOAD_WATCHDOG_MS);

    loadingTask.promise
      .then(function (doc) {
        if (settled) return undefined;
        settled = true;
        clearTimeout(watchdog);
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
          var scale = targetWidthPx / pageWidthPt;
          var viewport = page.getViewport({ scale: scale, rotation: 0 });
          var widthPx = Math.max(1, Math.round(viewport.width));
          var heightPx = Math.max(1, Math.round(viewport.height));

          var canvas = document.getElementById('canvas');
          canvas.width = widthPx;
          canvas.height = heightPx;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, widthPx, heightPx);

          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
            var pngDataUri = canvas.toDataURL('image/png');
            // Free the canvas memory before reporting back.
            canvas.width = 1;
            canvas.height = 1;
            post({
              id: id,
              ok: true,
              pngDataUri: pngDataUri,
              widthPx: widthPx,
              heightPx: heightPx,
              pageWidthPt: pageWidthPt,
              pageHeightPt: pageHeightPt,
              pageCount: pageCount,
            });
          });
        });
      })
      .catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        post({ id: id, ok: false, error: (err && err.message) ? err.message : String(err) });
      });
  }

  window.__pdfRender = function (id, pageIndex, targetWidthPx) {
    var base64 = chunks.join('');
    chunks = [];
    renderOnce(id, pageIndex, targetWidthPx, base64, 0);
  };

  post({ id: '__ready__', ok: true });
})();
</script>
</body>
</html>`;
}

/**
 * Mount this ONCE near the app root. It hosts the hidden offscreen WebView used
 * as the rendering engine and exposes the rasterize function via context.
 */
export const PdfRasterizerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const webviewRef = useRef<WebView>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Pending requests keyed by id, plus a FIFO queue so only one render runs at
  // a time (the single canvas/WebView is a shared resource).
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const queueRef = useRef<{ id: string; args: Required<RasterizeArgs> }[]>([]);
  const busyRef = useRef(false);
  const idCounterRef = useRef(0);

  // Load + inline the bundled pdf.js sources once. Reads from the local asset
  // file only — no network access.
  useEffect(() => {
    let cancelled = false;
    (async () => {
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
        if (!cancelled) {
          setHtml(buildHtml(mainSource, workerSource));
        }
      } catch (err) {
        if (!cancelled) {
          // The WebView never mounts (html stays null), so rasterize() calls
          // queue but cannot run; they reject via the per-request timeout.
          reportError(err, 'pdfjs-assets-load');
          console.error('PdfRasterizer: failed to load bundled pdf.js assets', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pumpQueue = useCallback(() => {
    if (busyRef.current || !ready) {
      return;
    }
    const next = queueRef.current.shift();
    if (!next) {
      return;
    }
    busyRef.current = true;
    const { id, args } = next;
    const wv = webviewRef.current;
    if (!wv) {
      busyRef.current = false;
      const pending = pendingRef.current.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRef.current.delete(id);
        pending.reject(new Error('PdfRasterizer: WebView unavailable'));
      }
      return;
    }

    // Reset, stream the base64 in chunks, then trigger the render. Returning
    // `true` from injected JS is required by react-native-webview.
    wv.injectJavaScript('window.__pdfReset && window.__pdfReset(); true;');
    for (let offset = 0; offset < args.base64.length; offset += BASE64_CHUNK_SIZE) {
      const chunk = args.base64.slice(offset, offset + BASE64_CHUNK_SIZE);
      const chunkLiteral = JSON.stringify(chunk);
      wv.injectJavaScript(`window.__pdfAppend && window.__pdfAppend(${chunkLiteral}); true;`);
    }
    const idLiteral = JSON.stringify(id);
    wv.injectJavaScript(
      `window.__pdfRender && window.__pdfRender(${idLiteral}, ${args.pageIndex}, ${args.targetWidthPx}); true;`,
    );
  }, [ready]);

  // Whenever the engine becomes ready (initial load or after a reload), drain
  // any queued requests.
  useEffect(() => {
    if (ready) {
      pumpQueue();
    }
  }, [ready, pumpQueue]);

  const finishCurrent = useCallback(() => {
    busyRef.current = false;
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
          setReady(true);
        }
        return;
      }

      const pending = pendingRef.current.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      pendingRef.current.delete(message.id);
      if (message.ok) {
        pending.resolve({
          pngDataUri: message.pngDataUri,
          widthPx: message.widthPx,
          heightPx: message.heightPx,
          pageWidthPt: message.pageWidthPt,
          pageHeightPt: message.pageHeightPt,
          pageCount: message.pageCount,
        });
      } else {
        pending.reject(new Error(message.error));
      }
      finishCurrent();
    },
    [finishCurrent],
  );

  // If the WebView process reloads/crashes, the engine is no longer ready and
  // must re-announce itself before we resume the queue.
  const handleLoadStart = useCallback(() => {
    setReady(false);
  }, []);

  // `rasterize` is stable (empty deps) but needs the latest pumpQueue; bridge
  // them through a ref so we don't recreate the public function on every render.
  const pumpQueueRef = useRef(pumpQueue);
  useEffect(() => {
    pumpQueueRef.current = pumpQueue;
  }, [pumpQueue]);

  const rasterize = useCallback<RasterizeFn>((args) => {
    return new Promise<RasterResult>((resolve, reject) => {
      if (!args.base64) {
        reject(new Error('PdfRasterizer: base64 is empty'));
        return;
      }
      idCounterRef.current += 1;
      const id = `req-${idCounterRef.current}`;
      const normalized: Required<RasterizeArgs> = {
        base64: args.base64,
        pageIndex: args.pageIndex,
        targetWidthPx: args.targetWidthPx ?? DEFAULT_TARGET_WIDTH_PX,
      };
      const timeout = setTimeout(() => {
        const stillPending = pendingRef.current.get(id);
        if (stillPending) {
          pendingRef.current.delete(id);
          stillPending.reject(
            new Error(`PdfRasterizer: render timed out after ${RENDER_TIMEOUT_MS}ms`),
          );
          // The timed-out request was the in-flight one; free the engine.
          busyRef.current = false;
          pumpQueueRef.current();
        }
      }, RENDER_TIMEOUT_MS);

      pendingRef.current.set(id, { resolve, reject, timeout });
      queueRef.current.push({ id, args: normalized });
      pumpQueueRef.current();
    });
  }, []);

  // Reject everything still pending on unmount so callers never hang.
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      pending.forEach((req) => {
        clearTimeout(req.timeout);
        req.reject(new Error('PdfRasterizer: provider unmounted'));
      });
      pending.clear();
    };
  }, []);

  const contextValue = useMemo(() => rasterize, [rasterize]);

  return (
    <PdfRasterizerContext.Provider value={contextValue}>
      {html ? (
        <View style={styles.hidden} pointerEvents="none" collapsable={false}>
          <WebView
            ref={webviewRef}
            source={{ html }}
            originWhitelist={['*']}
            onMessage={handleMessage}
            onLoadStart={handleLoadStart}
            javaScriptEnabled
            // Offline guarantee: the document is self-contained, so no remote
            // loads are needed or expected.
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            androidLayerType="software"
            // Avoid scaling/zoom affecting the offscreen canvas.
            scalesPageToFit={false}
            // Render bitmaps eagerly even while offscreen.
            cacheEnabled={false}
          />
        </View>
      ) : null}
      {children}
    </PdfRasterizerContext.Provider>
  );
};

/**
 * Returns a function that resolves with the rendered page. Calls are serialized
 * (one render at a time) and reject on error or after a ~30s timeout.
 */
export function usePdfRasterizer(): RasterizeFn {
  const ctx = useContext(PdfRasterizerContext);
  if (!ctx) {
    throw new Error('usePdfRasterizer must be used within a <PdfRasterizerProvider>');
  }
  return ctx;
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
