/**
 * The provider's real page against the REAL shipped pdf.js 6 (#554).
 *
 * pdf.js's "fake worker" runs the worker's message handler on the page's own
 * thread. It takes that handler from `window.pdfjsWorker`, or else imports
 * `GlobalWorkerOptions.workerSrc` — and it caches a failure for the page's
 * lifetime. Inline mode (an about:blank page with no loopback server) must
 * therefore never let pdf.js load the worker by URL. Field result before the
 * fix: 'Setting up fake worker failed: "…"' on every render.
 *
 * Here the page's scripts run in a `vm` realm the way a WebView runs them:
 * the classic scripts in order, then the pdf.js module (inline modules are
 * deferred), then DOMContentLoaded. There is no usable `Worker`, so pdf.js
 * must use the fake worker, and no script can be loaded by URL: the page has
 * to evaluate the bundled worker module itself. A JPEG 2000 page decodes
 * through the wasm the page hands pdf.js (no URL either).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { URL as NodeURL, URLSearchParams as NodeURLSearchParams } from 'node:url';
import vm from 'node:vm';
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { buildClassicPdf } from '@core/geo/geopdf/testUtils';
import {
  PDFJS_ASSET_DIR,
  PDFJS_MAIN_SOURCE,
  PDFJS_WORKER_SOURCE,
  evaluateModule,
  installRealmStructuredClone,
} from '@core/geo/pdfjsRealm.testUtils';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

const WASM = {
  'openjpeg.wasm': readFileSync(join(PDFJS_ASSET_DIR, 'openjpeg.wasm.pdfjs')).toString('base64'),
  'jbig2.wasm': readFileSync(join(PDFJS_ASSET_DIR, 'jbig2.wasm.pdfjs')).toString('base64'),
};

const mockInject = jest.fn();
let mockProps: {
  source?: { html?: string; uri?: string };
  onMessage: (event: { nativeEvent: { data: string } }) => void;
};
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(props: typeof mockProps, ref) {
      mockProps = props;
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
      return null;
    }),
  };
});
jest.mock(
  '@data/pdfRenderRecovery',
  () => ({ beginPdfRender: () => 'token', finishPdfRender: jest.fn() }),
  { virtual: true },
);
jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: () => false,
  renderNativePdfCrop: jest.fn(),
  deleteNativePdfOutput: jest.fn(),
}));
// The real bundled pdf.js, read from assets/pdfjs (see ./pdfjsAssets).
jest.mock('./pdfjsAssets', () => ({
  loadPdfjsSources: async () => mockSources,
  stagePdfjsFallbacks: async () => undefined,
}));
const mockSources = { main: '', worker: '', wasm: {}, fallbacks: {} };
// `up: false` is inline mode — no loopback server, the failing phone's path.
const mockServer = { up: false, html: '' };
jest.mock('@data/localServer', () => ({
  acquireLocalServer: async () => {
    if (!mockServer.up) throw new Error('Loopback server failed to start after 2 attempts');
    return { value: 'http://127.0.0.1:8080', release: async () => undefined };
  },
  probeLocalServer: async () => mockServer.up,
  restartLocalServer: async (origin: string) => origin,
  writeServedText: (_path: string, html: string) => {
    mockServer.html = html;
    return 'file:///doc/.rasterizer/index.html';
  },
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

/** Every `putImageData` a 2D context received: where pdf.js' image pixels land. */
const putImages: { width: number; height: number; data: Uint8ClampedArray }[] = [];

/** A 2D context that accepts every call pdf.js makes and draws nothing. */
function nullContext(canvas: object): object {
  const state: Record<string | symbol, unknown> = { canvas };
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'getImageData' || prop === 'createImageData') {
        return (...args: number[]) => {
          const w = Math.max(1, args.length >= 4 ? (args[2] ?? 1) : (args[0] ?? 1));
          const h = Math.max(1, args.length >= 4 ? (args[3] ?? 1) : (args[1] ?? 1));
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        };
      }
      if (prop === 'putImageData') {
        return (image: { width: number; height: number; data: Uint8ClampedArray }) => {
          putImages.push({ width: image.width, height: image.height, data: image.data.slice() });
        };
      }
      if (prop === 'getTransform') return () => new FakeDOMMatrix();
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop === 'createPattern' || prop === 'createLinearGradient') {
        return () => ({ addColorStop: () => undefined, setTransform: () => undefined });
      }
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function fakeCanvas(): Record<string, unknown> {
  const canvas: Record<string, unknown> = {
    width: 0,
    height: 0,
    style: {},
    toDataURL: () => 'data:image/png;base64,UE5H',
  };
  canvas.getContext = () => nullContext(canvas);
  return canvas;
}

/** The DOMMatrix subset pdf.js 6 uses (real arithmetic, so its math holds). */
class FakeDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  is2D = true;
  constructor(init?: number[]) {
    if (init)
      [this.a, this.b, this.c, this.d, this.e, this.f] = init as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
  }
  private set(m: number[]): this {
    [this.a, this.b, this.c, this.d, this.e, this.f] = m as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return this;
  }
  private static mul(
    p: FakeDOMMatrix,
    q: { a: number; b: number; c: number; d: number; e: number; f: number },
  ) {
    return [
      p.a * q.a + p.c * q.b,
      p.b * q.a + p.d * q.b,
      p.a * q.c + p.c * q.d,
      p.b * q.c + p.d * q.d,
      p.a * q.e + p.c * q.f + p.e,
      p.b * q.e + p.d * q.f + p.f,
    ];
  }
  multiplySelf(o: FakeDOMMatrix): this {
    return this.set(FakeDOMMatrix.mul(this, o));
  }
  preMultiplySelf(o: FakeDOMMatrix): this {
    return this.set(FakeDOMMatrix.mul(o, this));
  }
  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c || 1;
    const { a, b, c, d, e, f } = this;
    return this.set([
      d / det,
      -b / det,
      -c / det,
      a / det,
      (c * f - d * e) / det,
      (b * e - a * f) / det,
    ]);
  }
}

/** pdf.js 6 draws paths through Path2D. */
class FakePath2D {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  rect(): void {}
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);

const VECTOR_PDF = Buffer.from(
  buildClassicPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>',
      '<< /Length 21 >>\nstream\n0 0 1 rg 10 10 50 50 re f\nendstream',
    ],
    1,
  ),
).toString('base64');

/**
 * A 4×4 lossless JPEG 2000 image (OpenJPEG 2.5, `-n 2`): red, green / blue,
 * white quadrants, 2×2 pixels each.
 */
const JPX_4X4 =
  'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAABAAAAAQAAwcHAAAAAAAPY29scgEAAAAAABAAAADSanAyY/9P/1EALwAAAAAABAAAAAQAAAAAAAAAAAAAAAQAAAAEAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAQEEBAAB/1wAB0BASEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAVwAB/5PPtBQIxMGAr/8YMAptQ6Bn3/8YMATwKAJKV8faCQ+oDg+oCAw1Eo8OGpUFX8/ACj7QIAKnBnTfmCT8AWPwAgU2mIcE8Tz2fwVf/9k=';
const JPX_PDF = (() => {
  const jpx = Buffer.from(JPX_4X4, 'base64').toString('latin1');
  return Buffer.from(
    buildClassicPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>',
        '<< /Length 27 >>\nstream\nq 100 0 0 100 0 0 cm /Im Do Q\nendstream',
        `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /Filter /JPXDecode /Length ${jpx.length} >>\nstream\n${jpx}\nendstream`,
      ],
      1,
    ),
  ).toString('base64');
})();

/** `window.location`: pdf.js also passes it to `new URL(…, location)`. */
function pageLocation(href: string, origin: string) {
  return { href, origin, toString: () => href };
}

interface PageOptions {
  /** Served from the loopback origin instead of inline (about:blank). */
  served?: boolean;
  /** A `Worker` constructor for the page; none means pdf.js cannot start one. */
  Worker?: unknown;
  /** Page timers run this many times faster (the 12 s load watchdog). */
  speedup?: number;
}

type ScriptElement = { type?: string; text?: string; src?: string; onerror?: (e: unknown) => void };

/** Mount the provider and run its page in a VM realm, as the WebView would. */
async function loadPage({ served = false, Worker, speedup = 1 }: PageOptions = {}) {
  mockSources.main = PDFJS_MAIN_SOURCE;
  mockSources.worker = PDFJS_WORKER_SOURCE;
  (mockSources as { wasm: Record<string, string> }).wasm = WASM;
  mockServer.up = served;
  mockServer.html = '';
  putImages.length = 0;
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const html = served ? mockServer.html : (mockProps.source?.html ?? '');
  const scripts = [...html.matchAll(/<script( type="module")?>([\s\S]*?)<\/script>/g)].map((m) => ({
    module: !!m[1],
    text: m[2] ?? '',
  }));
  expect(scripts.filter((s) => s.module)).toHaveLength(1);

  const loadedBySrc: string[] = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const on = (type: string, fn: (event: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)?.add(fn);
  };
  const off = (type: string, fn: (event: unknown) => void) => listeners.get(type)?.delete(fn);
  const fire = (type: string, event: unknown = { type }) =>
    [...(listeners.get(type) ?? [])].forEach((fn) => fn(event));
  const stage = fakeCanvas();
  const window: Record<string, unknown> = {
    location: served
      ? pageLocation('http://127.0.0.1:8080/.rasterizer/index.html', 'http://127.0.0.1:8080')
      : pageLocation('about:blank', 'null'),
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/83' },
    // Node's, so blob: URLs really are created, as in a WebView (the
    // jest-expo globals are React Native's polyfills).
    Blob: NodeBlob,
    URL: NodeURL,
    URLSearchParams: NodeURLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    AbortSignal,
    ReadableStream,
    WritableStream,
    TransformStream,
    DecompressionStream,
    CompressionStream,
    Response,
    DOMException,
    Path2D: FakePath2D,
    DOMMatrix: FakeDOMMatrix,
    atob: (s: string) => Buffer.from(s, 'base64').toString('latin1'),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, (ms ?? 0) / speedup),
    clearTimeout,
    queueMicrotask,
    ...(Worker !== undefined ? { Worker } : {}),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    addEventListener: on,
    removeEventListener: off,
    ReactNativeWebView: {
      postMessage: (message: string) => mockProps.onMessage({ nativeEvent: { data: message } }),
    },
  };
  const context = vm.createContext(window);
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  installRealmStructuredClone(context);
  const insert = (el: ScriptElement) => {
    if (el.src) {
      // The failing phone could not load the worker by URL; neither can this page.
      loadedBySrc.push(el.src);
      setTimeout(() => el.onerror?.(new Error(`Cannot load script at: ${el.src}`)), 0);
    } else if (el.type === 'module' && el.text) {
      // A dynamically inserted module runs asynchronously; errors reach onerror.
      const text = el.text;
      setTimeout(() => {
        try {
          evaluateModule(text, context, 'inserted.mjs');
        } catch (error) {
          fire('error', { error });
        }
      }, 0);
    } else if (el.text) {
      vm.runInContext(el.text, context);
    }
    return el;
  };
  const head = { appendChild: insert, append: insert };
  window.document = {
    currentScript: null,
    head,
    documentElement: head,
    body: head,
    getElementById: () => stage,
    createElement: (tag: string) => (tag === 'canvas' ? fakeCanvas() : { tagName: tag }),
    addEventListener: on,
    removeEventListener: off,
  };
  mockInject.mockImplementation((code: string) => vm.runInContext(code, context));
  await act(async () => {
    // Classic scripts run as parsed; the module is deferred to the end of
    // parsing, then DOMContentLoaded fires.
    for (const script of scripts) if (!script.module) vm.runInContext(script.text, context);
    for (const script of scripts)
      if (script.module) evaluateModule(script.text, context, 'pdf.mjs');
    fire('DOMContentLoaded');
  });
  return { view, window, loadedBySrc };
}

afterEach(() => mockInject.mockReset());

it('renders in inline mode with no Worker and no script-by-URL, on the main thread', async () => {
  const { view, window, loadedBySrc } = await loadPage();
  const result = await act(() =>
    view.result.current({ source: { base64: VECTOR_PDF }, pageIndex: 0, targetWidthPx: 400 }),
  );
  expect(result).toMatchObject({ pageWidthPt: 200, pageHeightPt: 100, pageCount: 1 });
  // The bundled worker was evaluated into the page: pdf.js needed no URL.
  expect(
    (window.pdfjsWorker as { WorkerMessageHandler?: unknown } | undefined)?.WorkerMessageHandler,
  ).toBeDefined();
  expect(loadedBySrc).toEqual([]);
}, 30_000);

/** A Web Worker that starts and never answers: what a wedged WebView worker looks like. */
class SilentWorker {
  constructor(public readonly url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  terminate(): void {}
}

it('recovers a wedged worker through the load watchdog, on the main thread', async () => {
  // Served (same-origin) pages keep the real worker; it never answers, so the
  // page's 12 s watchdog must retry on the main thread. That retry used to
  // empty workerSrc, which makes pdf.js throw before it starts.
  const { view, window } = await loadPage({ served: true, Worker: SilentWorker, speedup: 100 });
  expect(window.pdfjsWorker).toBeUndefined();
  const result = await act(() =>
    view.result.current({ source: { base64: VECTOR_PDF }, pageIndex: 0, targetWidthPx: 400 }),
  );
  expect(result).toMatchObject({ pageWidthPt: 200, pageHeightPt: 100, pageCount: 1 });
  expect(
    (window.pdfjsWorker as { WorkerMessageHandler?: unknown } | undefined)?.WorkerMessageHandler,
  ).toBeDefined();
}, 30_000);

it('decodes a JPEG 2000 image through the bundled wasm, with no URL to fetch it from', async () => {
  const { view, loadedBySrc } = await loadPage();
  const result = await act(() =>
    view.result.current({ source: { base64: JPX_PDF }, pageIndex: 0, targetWidthPx: 100 }),
  );
  expect(result).toMatchObject({ pageWidthPt: 100, pageHeightPt: 100, pageCount: 1 });
  expect(loadedBySrc).toEqual([]);
  // The decoded pixels reached the canvas: the 4×4 image, its four quadrants.
  // pdf.js copies decoded images in 16-row chunks: the first chunk holds all 4 rows.
  const image = putImages.find((p) => p.width === 4 && p.height >= 4);
  expect(image).toBeDefined();
  const pixel = (x: number, y: number) => [
    ...(image?.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 3) ?? []),
  ];
  expect(pixel(0, 0)).toEqual([255, 0, 0]);
  expect(pixel(3, 0)).toEqual([0, 255, 0]);
  expect(pixel(0, 3)).toEqual([0, 0, 255]);
  expect(pixel(3, 3)).toEqual([255, 255, 255]);
}, 30_000);
