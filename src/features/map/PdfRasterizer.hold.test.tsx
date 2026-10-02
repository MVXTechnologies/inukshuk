/**
 * Holding the open document across a burst of detail tiles.
 *
 * Opening a GeoPDF and building its page's operator list is most of a tile
 * render and nearly independent of the crop, so consecutive requests naming
 * the same hold key reuse the document (and page) the previous one opened.
 * The page script runs in a `vm` context against a scripted pdf.js that counts
 * opens and releases.
 */
import { runInNewContext } from 'node:vm';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
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
const mockInject = jest.fn();
let mockProps: { onMessage: (event: { nativeEvent: { data: string } }) => void } | null = null;
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(props: NonNullable<typeof mockProps>, ref) {
      mockProps = props;
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
      return null;
    }),
  };
});
jest.mock('../../../assets/pdfjs/pdf.legacy.min.js.pdfjs', () => 1);
jest.mock('../../../assets/pdfjs/pdf.worker.legacy.min.js.pdfjs', () => 2);
jest.mock('expo-asset', () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => ({ localUri: 'file://asset' }) }) },
}));
jest.mock('expo-file-system', () => ({
  File: class {
    async text() {
      return '';
    }
  },
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

type Posted = { id: string; ok: boolean; error?: string; loadMs?: number; reused?: boolean };

function scriptedPdfjs(options: { failRender?: () => boolean } = {}) {
  const stats = { opens: 0, destroys: 0, getPage: 0 };
  const page = {
    rotate: 0,
    userUnit: 1,
    view: [0, 0, 1000, 800],
    getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 800 * scale }),
    render: () => ({
      promise: options.failRender?.()
        ? Promise.reject(new Error('paint failed'))
        : Promise.resolve(),
    }),
  };
  const doc = {
    numPages: 1,
    getPage: async () => {
      stats.getPage += 1;
      return page;
    },
  };
  const lib = {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => {
      stats.opens += 1;
      return {
        onProgress: null,
        destroy: async () => {
          stats.destroys += 1;
        },
        promise: Promise.resolve(doc),
      };
    },
  };
  return { lib, stats };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);

async function loadPage(options: { failRender?: () => boolean } = {}) {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: () => undefined }),
    toDataURL: () => 'data:image/png;base64,PNG',
  };
  // The page's idle release runs on these timers; the test fires them.
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const { lib, stats } = scriptedPdfjs(options);
  const posted: Posted[] = [];
  const window: Record<string, unknown> = {
    location: { href: 'http://127.0.0.1:8080/.rasterizer/index.html' },
    URL,
    document: { getElementById: () => canvas },
    setTimeout: (fn: () => void) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    pdfjsLib: lib,
    ReactNativeWebView: {
      postMessage: (message: string) => {
        posted.push(JSON.parse(message) as Posted);
        mockProps?.onMessage({ nativeEvent: { data: message } });
      },
    },
  };
  window.window = window;
  window.globalThis = window;
  await act(async () => {
    runInNewContext(scripts.at(-1)!, window);
  });
  const render = async (id: string, look: object, url = 'http://127.0.0.1:8080/maps/m.pdf') => {
    await act(async () => {
      runInNewContext(
        `window.__pdfRender(${JSON.stringify(id)}, 0, 20, ${JSON.stringify(url)}, {"x0":0,"y0":0,"x1":0.5,"y1":0.5}, null, ${JSON.stringify(look)})`,
        window,
      );
      for (let i = 0; i < 20 && !posted.some((m) => m.id === id); i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    return posted.find((m) => m.id === id);
  };
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    });
  };
  const fireTimers = async () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const fn of pending) fn();
    await settle();
  };
  return { view, render, stats, fireTimers, settle };
}

afterEach(() => {
  mockInject.mockReset();
  mockProps = null;
});

it('opens the document once for a burst of tiles with the same hold key', async () => {
  const { view, render, stats, fireTimers } = await loadPage();
  const first = await render('t1', { whiteKey: 0, hold: 'maps/m.pdf@1' });
  const second = await render('t2', { whiteKey: 0, hold: 'maps/m.pdf@1' });
  const third = await render('t3', { whiteKey: 0, hold: 'maps/m.pdf@1' });
  expect([first?.ok, second?.ok, third?.ok]).toEqual([true, true, true]);
  expect(first?.reused).toBeUndefined();
  expect(second?.reused).toBe(true);
  expect(third?.reused).toBe(true);
  expect(stats.opens).toBe(1);
  expect(stats.getPage).toBe(1);
  expect(stats.destroys).toBe(0);
  // Released once the burst goes quiet.
  await fireTimers();
  expect(stats.destroys).toBe(1);
  await render('t4', { whiteKey: 0, hold: 'maps/m.pdf@1' });
  expect(stats.opens).toBe(2);
  await view.unmount();
});

it('opens and releases per request without a hold key (overviews, older callers)', async () => {
  const { view, render, stats, settle } = await loadPage();
  await render('o1', { whiteKey: 0 });
  await render('o2', { whiteKey: 0 });
  await settle();
  expect(stats.opens).toBe(2);
  expect(stats.destroys).toBe(2);
  await view.unmount();
});

it('releases the held document as soon as another document or revision is asked for', async () => {
  const { view, render, stats, settle } = await loadPage();
  await render('a1', { whiteKey: 0, hold: 'maps/a.pdf@1' });
  const other = await render('b1', { whiteKey: 0, hold: 'maps/a.pdf@2' });
  await settle();
  expect(other?.reused).toBeUndefined();
  expect(stats.opens).toBe(2);
  expect(stats.destroys).toBe(1);
  await render('c1', { whiteKey: 0 });
  await settle();
  // The unheld request released the held one and its own document.
  expect(stats.destroys).toBe(3);
  await view.unmount();
});

it('never keeps a document whose render failed', async () => {
  let fail = false;
  const { view, render, stats, settle } = await loadPage({ failRender: () => fail });
  await render('h1', { whiteKey: 0, hold: 'k' });
  fail = true;
  const failed = await render('h2', { whiteKey: 0, hold: 'k' });
  expect(failed).toMatchObject({ ok: false });
  fail = false;
  const next = await render('h3', { whiteKey: 0, hold: 'k' });
  await settle();
  expect(next?.reused).toBeUndefined();
  expect(stats.opens).toBe(2);
  expect(stats.destroys).toBe(1);
  await view.unmount();
});

it('sends the hold key to the page only when the caller gives one (RN side)', async () => {
  const { view } = await loadPage();
  const source = { url: 'http://127.0.0.1:8080/maps/m.pdf' };
  const held = view.result
    .current({ source, pageIndex: 0, holdKey: 'maps/m.pdf@7' })
    .catch(() => undefined);
  expect(String(mockInject.mock.calls.at(-1)?.[0] ?? '')).toContain(
    '{"whiteKey":0,"hold":"maps/m.pdf@7"}); true;',
  );
  await view.unmount();
  await held;
});
