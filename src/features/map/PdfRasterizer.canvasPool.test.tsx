/**
 * The page's pooled canvas factory for pdf.js' scratch canvases.
 *
 * pdf.js 6 creates and destroys a canvas per image per paint; on WebKit that
 * made every repaint of a scanned sheet (hundreds of image tiles, each
 * downscaled through two or three canvases) about twice as slow as 3.11,
 * which reused its scratch canvases. The page hands pdf.js a factory that
 * reuses canvases of the same size, reset to a blank default-state canvas,
 * within a pixel cap. Run here against the page's own script in a VM.
 */
import { runInNewContext } from 'node:vm';
import { Blob as NodeBlob } from 'node:buffer';
import { URL as NodeURL } from 'node:url';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { renderHook } from '@testing-library/react-native';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

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
jest.mock('react-native-webview', () => ({ WebView: () => null }));
// The bundled pdf.js sources (see ./pdfjsAssets); these tests script pdf.js.
jest.mock('./pdfjsAssets', () => ({
  loadPdfjsSources: async () => ({ main: '', worker: '', wasm: {}, fallbacks: {} }),
  stagePdfjsFallbacks: async () => undefined,
}));
jest.mock('@data/localServer', () => ({
  acquireLocalServer: async () => ({
    value: 'http://127.0.0.1:8080',
    release: async () => undefined,
  }),
  probeLocalServer: async () => true,
  restartLocalServer: async (origin: string) => origin,
  writeServedText: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

interface FakeCanvas {
  width: number;
  height: number;
  id: number;
  resets: number;
  getContext: (type: string, options?: object) => object;
  contextOptions?: object;
}
type Entry = { canvas: FakeCanvas | null; context: { reset?: () => void } | null };
interface Factory {
  create(width: number, height: number): Entry;
  reset(entry: Entry, width: number, height: number): void;
  destroy(entry: Entry): void;
}
interface Pool {
  factory: new (options: object) => Factory;
  clear(): void;
  size(): number;
}

/** Run the page script; returns its canvas pool and what getDocument received. */
async function loadPage({ contextReset = true } = {}) {
  await renderHook(usePdfRasterizer, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
    ),
  });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  let nextId = 1;
  const created: FakeCanvas[] = [];
  const opened: Record<string, unknown>[] = [];
  const document = {
    getElementById: () => null,
    createElement: () => {
      const canvas: FakeCanvas = {
        width: 300,
        height: 150,
        id: nextId++,
        resets: 0,
        getContext(_type, options) {
          canvas.contextOptions = options;
          return contextReset
            ? {
                reset: () => {
                  canvas.resets += 1;
                },
              }
            : {};
        },
      };
      created.push(canvas);
      return canvas;
    },
  };
  const window: Record<string, unknown> = {
    location: { href: 'http://127.0.0.1:8080/.rasterizer/index.html' },
    URL: NodeURL,
    Blob: NodeBlob,
    document,
    setTimeout,
    clearTimeout,
    ReactNativeWebView: { postMessage: () => undefined },
    pdfjsLib: {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: (params: Record<string, unknown>) => {
        opened.push(params);
        return { promise: new Promise(() => undefined), destroy: async () => undefined };
      },
    },
  };
  window.window = window;
  runInNewContext(script!, window);
  const pool = window.__pdfCanvasPool as Pool;
  return { window, pool, factory: new pool.factory({ ownerDocument: document }), created, opened };
}

it('gives pdf.js the pooling factory on every open', async () => {
  const { window, pool, opened } = await loadPage();
  (window.__pdfRender as (...a: unknown[]) => void)(
    'r1',
    0,
    512,
    'http://127.0.0.1:8080/maps/m.pdf',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened[0]?.CanvasFactory).toBe(pool.factory);
});

it('reuses a destroyed canvas of the same size, reset to a blank default state', async () => {
  const { factory, created } = await loadPage();
  const a = factory.create(512, 512);
  expect(created).toHaveLength(1);
  expect(a.canvas?.contextOptions).toEqual({ willReadFrequently: false });
  const first = a.canvas;
  factory.destroy(a);
  expect(a.canvas).toBeNull();
  expect(a.context).toBeNull();
  const b = factory.create(512, 512);
  expect(b.canvas).toBe(first);
  expect(created).toHaveLength(1);
  expect(first?.resets).toBe(1);
  // Another size is a new canvas.
  const c = factory.create(256, 256);
  expect(c.canvas).not.toBe(first);
  expect(created).toHaveLength(2);
});

it('resets by re-setting the width where the context has no reset()', async () => {
  const { factory } = await loadPage({ contextReset: false });
  const a = factory.create(64, 32);
  const canvas = a.canvas!;
  factory.destroy(a);
  let widthWrites = 0;
  let width = canvas.width;
  Object.defineProperty(canvas, 'width', {
    get: () => width,
    set: (v: number) => {
      widthWrites += 1;
      width = v;
    },
  });
  const b = factory.create(64, 32);
  expect(b.canvas).toBe(canvas);
  expect(widthWrites).toBe(1);
  expect(canvas.width).toBe(64);
});

it('never pools big canvases and keeps the pool under its pixel cap', async () => {
  const { factory, pool } = await loadPage();
  const big = factory.create(2048, 2048); // 4 Mi px: above a quarter of the 8 Mi px cap
  const bigCanvas = big.canvas!;
  factory.destroy(big);
  expect(pool.size()).toBe(0);
  expect(bigCanvas.width).toBe(0);
  // 1 Mi px each: the ninth pushes the oldest out.
  const entries = Array.from({ length: 9 }, () => factory.create(1024, 1024));
  const firstCanvas = entries[0]!.canvas!;
  entries.forEach((e) => factory.destroy(e));
  expect(pool.size()).toBe(8);
  expect(firstCanvas.width).toBe(0);
});

it('releases the pool when RN asks (background, memory warning)', async () => {
  const { window, factory, pool } = await loadPage();
  const a = factory.create(128, 128);
  const canvas = a.canvas!;
  factory.destroy(a);
  expect(pool.size()).toBe(1);
  (window.__pdfDropHeld as () => void)();
  expect(pool.size()).toBe(0);
  expect(canvas.width).toBe(0);
});

it('rejects what pdf.js own factory rejects', async () => {
  const { factory } = await loadPage();
  expect(() => factory.create(0, 10)).toThrow('Invalid canvas size');
  expect(() => factory.destroy({ canvas: null, context: null })).toThrow('Canvas is not specified');
  const a = factory.create(10, 10);
  expect(() => factory.reset(a, -1, 5)).toThrow('Invalid canvas size');
  factory.reset(a, 20, 30);
  expect([a.canvas?.width, a.canvas?.height]).toEqual([20, 30]);
});
