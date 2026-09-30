/**
 * "See-through white" in the rasterizer (`@core/geo/pdfWhiteKey`).
 *
 * The page's own scripts — the white-key runtime and the render script, both
 * extracted from the HTML the provider writes — run in a `vm` context against
 * a scripted pdf.js and a canvas that holds real pixels. Under test: a keyed
 * request runs exactly one pass over what pdf.js painted before the PNG is
 * encoded (paper keyed out, ink and colour kept), an unkeyed one never reads
 * the pixels back, and a keyed page is never handed to a native renderer
 * (which cannot key) — neither by the page nor by the RN side.
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
  nativePdfAvailable: () => true,
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

type Posted = {
  id: string;
  ok: boolean;
  kind?: string;
  error?: string;
  keyMs?: number;
  widthPx?: number;
  heightPx?: number;
};

/** What pdf.js "paints": white paper, one black ink pixel, one green fill pixel. */
const INK = 0;
const GREEN = 1;
function paint(data: Uint8ClampedArray): void {
  data.fill(255);
  data.set([0, 0, 0, 255], INK * 4);
  data.set([205, 230, 190, 255], GREEN * 4);
}

/** A 2D context that keeps real RGBA pixels, like a browser canvas. */
function pixelCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    pixels: new Uint8ClampedArray(0),
    reads: 0,
    writes: [] as Uint8ClampedArray[],
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,PNG',
  };
  const ctx = {
    fillStyle: '',
    fillRect: () => {
      canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      paint(canvas.pixels);
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      canvas.reads += 1;
      return { width: w, height: h, data: Uint8ClampedArray.from(canvas.pixels) };
    },
    putImageData: (image: { data: Uint8ClampedArray }) => {
      canvas.writes.push(Uint8ClampedArray.from(image.data));
      canvas.pixels = Uint8ClampedArray.from(image.data);
    },
  };
  return canvas;
}

function scriptedPdfjs() {
  const page = {
    rotate: 0,
    userUnit: 1,
    view: [0, 0, 1000, 800],
    getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve() }),
  };
  const doc = { numPages: 1, getPage: async () => page };
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({
      onProgress: null,
      destroy: async () => undefined,
      promise: Promise.resolve(doc),
    }),
  };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);

async function loadPage() {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const runtime = scripts.find((s) => s.includes('__inkKeyWhite = keyWhite'));
  expect(runtime).toBeDefined();
  const canvas = pixelCanvas();
  const posted: Posted[] = [];
  const window: Record<string, unknown> = {
    location: { href: 'http://127.0.0.1:8080/.rasterizer/index.html' },
    URL,
    document: { getElementById: () => canvas },
    setTimeout,
    clearTimeout,
    pdfjsLib: scriptedPdfjs(),
    ReactNativeWebView: {
      postMessage: (message: string) => {
        posted.push(JSON.parse(message) as Posted);
        mockProps?.onMessage({ nativeEvent: { data: message } });
      },
    },
  };
  window.window = window;
  window.globalThis = window;
  runInNewContext(runtime!, window);
  await act(async () => {
    runInNewContext(scripts.at(-1)!, window);
  });
  /** Call the page's entry point directly, as RN's injected JS does. */
  const render = async (id: string, look: string, nativePage: object | null = null) => {
    await act(async () => {
      runInNewContext(
        `window.__pdfRender(${JSON.stringify(id)}, 0, 20, 'http://127.0.0.1:8080/maps/m.pdf', null, ${JSON.stringify(nativePage)}, ${look})`,
        window,
      );
      for (let i = 0; i < 20 && !posted.some((m) => m.id === id); i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    return posted.find((m) => m.id === id);
  };
  return { view, canvas, render, window };
}

const pixel = (data: Uint8ClampedArray | undefined, index: number) =>
  data ? Array.from(data.slice(index * 4, index * 4 + 4)) : null;

afterEach(() => {
  mockInject.mockReset();
  mockProps = null;
});

it('keys the painted paper out in one pass before encoding, keeping ink and colour', async () => {
  const { canvas, render, view } = await loadPage();
  const result = await render('k1', '{"whiteKey":1}');
  expect(result).toMatchObject({ id: 'k1', ok: true, widthPx: 20, heightPx: 16 });
  expect(typeof result?.keyMs).toBe('number');
  expect(canvas.reads).toBe(1);
  expect(canvas.writes).toHaveLength(1);
  const keyed = canvas.writes[0];
  expect(pixel(keyed, 5)?.[3]).toBe(0); // paper
  expect(pixel(keyed, INK)).toEqual([0, 0, 0, 255]);
  expect(pixel(keyed, GREEN)).toEqual([205, 230, 190, 255]);
  await view.unmount();
});

it('leaves "some" paper as a partial veil', async () => {
  const { canvas, render, view } = await loadPage();
  await render('k2', '{"whiteKey":0.55}');
  const alpha = pixel(canvas.writes[0], 5)?.[3] ?? -1;
  expect(alpha).toBeGreaterThan(0);
  expect(alpha).toBeLessThan(255);
  await view.unmount();
});

it.each([
  ['strength 0', '{"whiteKey":0}'],
  ['no look (an older caller)', 'undefined'],
])('never reads the pixels back when unkeyed (%s)', async (_name, look) => {
  const { canvas, render, view } = await loadPage();
  const result = await render('u1', look);
  expect(result).toMatchObject({ ok: true });
  expect(result?.keyMs).toBeUndefined();
  expect(canvas.reads).toBe(0);
  expect(canvas.writes).toHaveLength(0);
  await view.unmount();
});

it('keeps a keyed native-eligible page on pdf.js (the page side)', async () => {
  const { canvas, render, view } = await loadPage();
  const nativePage = { expectedPageWidthPt: 1000, expectedPageHeightPt: 800 };
  const unkeyed = await render('n0', '{"whiteKey":0}', nativePage);
  expect(unkeyed?.kind).toBe('native-geometry');
  const keyed = await render('n1', '{"whiteKey":1}', nativePage);
  expect(keyed?.kind).toBeUndefined();
  expect(keyed).toMatchObject({ ok: true });
  expect(canvas.writes).toHaveLength(1);
  await view.unmount();
});

it('sends the level as a strength and drops the native page for a keyed request (RN side)', async () => {
  const { view } = await loadPage();
  const nativePage = {
    fileUri: 'file:///Documents/maps/m.pdf',
    revision: 'r',
    expectedPageWidthPt: 1000,
    expectedPageHeightPt: 800,
  };
  const source = { url: 'http://127.0.0.1:8080/maps/m.pdf' };
  const pending = view.result
    .current({ source, pageIndex: 0, whiteKey: 'full', nativePage })
    .catch(() => undefined);
  const injected = String(mockInject.mock.calls.at(-1)?.[0] ?? '');
  expect(injected).toContain(', null, {"whiteKey":1}); true;');
  await view.unmount();
  await pending;
});

it('keeps the native page for an unkeyed request (RN side)', async () => {
  const { view } = await loadPage();
  const nativePage = {
    fileUri: 'file:///Documents/maps/m.pdf',
    revision: 'r',
    expectedPageWidthPt: 1000,
    expectedPageHeightPt: 800,
  };
  const source = { url: 'http://127.0.0.1:8080/maps/m.pdf' };
  const pending = view.result.current({ source, pageIndex: 0, nativePage }).catch(() => undefined);
  const injected = String(mockInject.mock.calls.at(-1)?.[0] ?? '');
  expect(injected).toContain('"expectedPageWidthPt":1000');
  expect(injected).toContain('{"whiteKey":0}); true;');
  await view.unmount();
  await pending;
});
