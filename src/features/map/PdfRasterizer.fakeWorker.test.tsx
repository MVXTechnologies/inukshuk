/**
 * The main-thread "fake worker" fallback, against REAL pdf.js 3.11.174 (#554).
 *
 * pdf.js's fake worker runs the worker's message handler on the page's own
 * thread. It takes that handler from `window.pdfjsWorker`, or else loads
 * `GlobalWorkerOptions.workerSrc` with a `<script src>` — and it caches a
 * failure for the page's lifetime. The page used to fall back by emptying
 * `workerSrc`, which makes pdf.js throw, and inline mode (an about:blank page
 * with no loopback server) left it loading a blob URL it may not be allowed
 * to load. Field result: 'Setting up fake worker failed: "…"' on every render.
 *
 * Here the provider's own page runs in a VM with the bundled pdf.js and its
 * worker, no `Worker` (so pdf.js must use the fake worker) and a document
 * that cannot load scripts by URL, as on the failing phone. The page must
 * still render, by evaluating the bundled worker source itself.
 */
import { Blob as NodeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL as NodeURL, URLSearchParams as NodeURLSearchParams } from 'node:url';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { buildClassicPdf } from '@core/geo/geopdf/testUtils';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

const ASSETS = join(__dirname, '../../../assets/pdfjs');
const MAIN_SOURCE = readFileSync(join(ASSETS, 'pdf.legacy.min.js.pdfjs'), 'utf8');
const WORKER_SOURCE = readFileSync(join(ASSETS, 'pdf.worker.legacy.min.js.pdfjs'), 'utf8');

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
jest.mock('../../../assets/pdfjs/pdf.legacy.min.js.pdfjs', () => 'main');
jest.mock('../../../assets/pdfjs/pdf.worker.legacy.min.js.pdfjs', () => 'worker');
jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: (id: string) => ({ downloadAsync: async () => ({ localUri: `file:///${id}` }) }),
  },
}));
jest.mock('expo-file-system', () => ({
  File: class {
    mockUri: string;
    constructor(mockUri: string) {
      this.mockUri = mockUri;
    }
    async text() {
      return this.mockUri.endsWith('worker') ? mockSources.worker : mockSources.main;
    }
  },
}));
const mockSources = { main: '', worker: '' };
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
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
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

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);

const PDF_BASE64 = Buffer.from(
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

/** Mount the provider and run its page in a VM, as the WebView would. */
async function loadPage({ served = false, Worker, speedup = 1 }: PageOptions = {}) {
  mockSources.main = MAIN_SOURCE;
  mockSources.worker = WORKER_SOURCE;
  mockServer.up = served;
  mockServer.html = '';
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const html = served ? mockServer.html : (mockProps.source?.html ?? '');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  expect(scripts.length).toBeGreaterThanOrEqual(4);

  const loadedBySrc: string[] = [];
  const stage = fakeCanvas();
  type ScriptElement = { text?: string; src?: string; onerror?: (e: unknown) => void };
  const insert = (el: ScriptElement) => {
    if (el.src) {
      // The failing phone could not load the worker by URL; neither can this page.
      loadedBySrc.push(el.src);
      setTimeout(() => el.onerror?.(new Error(`Cannot load script at: ${el.src}`)), 0);
    } else if (el.text) {
      runInNewContext(el.text, window);
    }
    return el;
  };
  const head = { appendChild: insert, append: insert };
  const window: Record<string, unknown> = {
    location: served
      ? pageLocation('http://127.0.0.1:8080/.rasterizer/index.html', 'http://127.0.0.1:8080')
      : pageLocation('about:blank', 'null'),
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/83' },
    document: {
      currentScript: null,
      head,
      documentElement: head,
      body: head,
      getElementById: () => stage,
      createElement: (tag: string) => (tag === 'canvas' ? fakeCanvas() : { tagName: tag }),
    },
    // Node's, so blob: URLs really are created, as in a WebView (the
    // jest-expo globals are React Native's polyfills).
    Blob: NodeBlob,
    URL: NodeURL,
    URLSearchParams: NodeURLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    ReadableStream,
    structuredClone,
    DOMException,
    atob: (s: string) => Buffer.from(s, 'base64').toString('latin1'),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, (ms ?? 0) / speedup),
    clearTimeout,
    ...(Worker !== undefined ? { Worker } : {}),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    ReactNativeWebView: {
      postMessage: (message: string) => mockProps.onMessage({ nativeEvent: { data: message } }),
    },
  };
  window.window = window;
  window.self = window;
  mockInject.mockImplementation((code: string) => runInNewContext(code, window));
  await act(async () => {
    for (const script of scripts) runInNewContext(script, window);
  });
  return { view, window, loadedBySrc };
}

afterEach(() => mockInject.mockReset());

it('renders in inline mode with no Worker and no script-by-URL, on the main thread', async () => {
  const { view, window, loadedBySrc } = await loadPage();
  const result = await act(() =>
    view.result.current({ source: { base64: PDF_BASE64 }, pageIndex: 0, targetWidthPx: 400 }),
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
    view.result.current({ source: { base64: PDF_BASE64 }, pageIndex: 0, targetWidthPx: 400 }),
  );
  expect(result).toMatchObject({ pageWidthPt: 200, pageHeightPt: 100, pageCount: 1 });
  expect(
    (window.pdfjsWorker as { WorkerMessageHandler?: unknown } | undefined)?.WorkerMessageHandler,
  ).toBeDefined();
}, 30_000);
