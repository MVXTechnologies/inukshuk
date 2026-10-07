/**
 * "See-through white" in the rasterizer (`@core/geo/pdfWhiteKey`).
 *
 * The page's own scripts — the white-key runtime and the render script, both
 * extracted from the HTML the provider writes — run in a `vm` context against
 * a scripted pdf.js and a canvas that holds real pixels. Under test: a keyed
 * request runs exactly one pass over what pdf.js painted before the PNG is
 * encoded (paper keyed out, ink and colour kept), an unkeyed one never reads
 * the pixels back, and a keyed native-eligible page still goes to the native
 * renderer: the page keys the tile it drew afterwards (`__pdfKeyImage`).
 */
import { runInNewContext } from 'node:vm';
import { Blob as NodeBlob } from 'node:buffer';
import { URL as NodeURL } from 'node:url';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

jest.mock(
  '@data/pdfRenderRecovery',
  () => ({ beginPdfRender: () => 'token', finishPdfRender: jest.fn() }),
  { virtual: true },
);
const mockRenderNative = jest.fn();
const mockDeleteNative = jest.fn();
jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: () => true,
  renderNativePdfCrop: (...args: unknown[]) => mockRenderNative(...args),
  deleteNativePdfOutput: (...args: unknown[]) => mockDeleteNative(...args),
}));
const mockCopyToServed = jest.fn(
  async (_source: string, path: string) => `file:///Documents/${path}`,
);
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
jest.mock('expo-file-system', () => ({
  File: class {
    async text() {
      return '';
    }
  },
}));
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
  copyToServed: (source: string, path: string) => mockCopyToServed(source, path),
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
    drawImage: () => {
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
  const loaded: string[] = [];
  const window: Record<string, unknown> = {
    location: { href: 'http://127.0.0.1:8080/.rasterizer/index.html' },
    URL: NodeURL,
    Blob: NodeBlob,
    document: { getElementById: () => canvas },
    setTimeout,
    clearTimeout,
    // An <img> that "decodes" at once: drawImage then paints the test pixels.
    Image: class {
      naturalWidth = 20;
      naturalHeight = 16;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(url: string) {
        loaded.push(url);
        setTimeout(() => (url.includes('missing') ? this.onerror?.() : this.onload?.()), 0);
      }
    },
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
  /** The page's entry point for a tile a native renderer drew. */
  const keyImage = async (id: string, url: string, strength: number) => {
    await act(async () => {
      runInNewContext(
        `window.__pdfKeyImage(${JSON.stringify(id)}, ${JSON.stringify(url)}, ${strength})`,
        window,
      );
      for (let i = 0; i < 20 && !posted.some((m) => m.id === id); i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    return posted.find((m) => m.id === id);
  };
  return { view, canvas, render, keyImage, loaded, window };
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

it('leaves 50 % paper as a partial veil', async () => {
  const { canvas, render, view } = await loadPage();
  await render('k2', '{"whiteKey":0.5}');
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

it('hands a keyed native-eligible page to the native renderer too (the page side)', async () => {
  const { canvas, render, view } = await loadPage();
  const nativePage = { expectedPageWidthPt: 1000, expectedPageHeightPt: 800 };
  expect((await render('n0', '{"whiteKey":0}', nativePage))?.kind).toBe('native-geometry');
  expect((await render('n1', '{"whiteKey":1}', nativePage))?.kind).toBe('native-geometry');
  expect(canvas.writes).toHaveLength(0);
  await view.unmount();
});

it('keys a native tile in one pass: paper out, ink and colour kept', async () => {
  const { canvas, keyImage, loaded, view } = await loadPage();
  const result = await keyImage('k9', 'http://127.0.0.1:8080/.rasterizer/key-k9.png', 1);
  expect(result).toMatchObject({ id: 'k9', kind: 'keyed', ok: true, widthPx: 20, heightPx: 16 });
  expect(loaded).toEqual(['http://127.0.0.1:8080/.rasterizer/key-k9.png']);
  expect(canvas.reads).toBe(1);
  const keyed = canvas.writes[0];
  expect(pixel(keyed, 5)?.[3]).toBe(0); // paper
  expect(pixel(keyed, INK)).toEqual([0, 0, 0, 255]);
  expect(pixel(keyed, GREEN)).toEqual([205, 230, 190, 255]);
  // The same pixels a keyed pdf.js render of that paint produces.
  const viaPdfjs = await loadPage();
  await viaPdfjs.render('k10', '{"whiteKey":1}');
  expect(Array.from(viaPdfjs.canvas.writes[0]!)).toEqual(Array.from(keyed!));
  await viaPdfjs.view.unmount();
  await view.unmount();
});

it('reports a native tile the page cannot load instead of hanging', async () => {
  const { keyImage, view } = await loadPage();
  const result = await keyImage('k11', 'http://127.0.0.1:8080/.rasterizer/missing.png', 1);
  expect(result).toMatchObject({ kind: 'keyed', ok: false });
  await view.unmount();
});

describe('a keyed native tile (RN side)', () => {
  const nativePage = {
    fileUri: 'file:///Documents/maps/m.pdf',
    revision: 'r',
    expectedPageWidthPt: 1000,
    expectedPageHeightPt: 800,
  };
  const source = { url: 'http://127.0.0.1:8080/maps/m.pdf' };
  const crop = { x0: 0, y0: 0, x1: 0.5, y1: 0.5 };
  const nativeResult = {
    fileUri: 'file:///cache/overlays/native.png',
    widthPx: 20,
    heightPx: 16,
    pageWidthPt: 1000,
    pageHeightPt: 800,
    pageCount: 1,
    loadMs: 5,
    renderMs: 7,
  };
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  /** Wire the mocked WebView's injected scripts into the VM page. */
  const connect = (window: Record<string, unknown>) =>
    mockInject.mockImplementation((script: string) => runInNewContext(script, window));
  beforeEach(() => {
    mockRenderNative.mockReset().mockResolvedValue(nativeResult);
    mockDeleteNative.mockReset();
    mockCopyToServed.mockClear();
  });

  it('renders natively, keys the tile in the page and cleans both files up', async () => {
    const { view, window, canvas, loaded } = await loadPage();
    connect(window);
    let result: unknown;
    await act(async () => {
      void view.result
        .current({ source, pageIndex: 0, crop, whiteKey: 2, nativePage })
        .then((r) => {
          result = r;
        });
    });
    await settle();
    expect(mockRenderNative).toHaveBeenCalledTimes(1);
    expect(mockCopyToServed).toHaveBeenCalledWith(
      nativeResult.fileUri,
      expect.stringMatching(/^\.rasterizer\/key-.*\.png$/),
    );
    expect(loaded[0]).toMatch(/^http:\/\/127\.0\.0\.1:8080\/\.rasterizer\/key-.*\.png$/);
    expect(result).toMatchObject({
      pngDataUri: 'data:image/png;base64,PNG',
      widthPx: 20,
      heightPx: 16,
      pageWidthPt: 1000,
      pageCount: 1,
    });
    expect((result as { fileUri?: string }).fileUri).toBeUndefined();
    // 50 %: a partial veil, from exactly one pass.
    expect(canvas.writes).toHaveLength(1);
    const alpha = pixel(canvas.writes[0], 5)?.[3] ?? -1;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(255);
    const deleted = mockDeleteNative.mock.calls.map(([uri]) => uri as string);
    expect(deleted).toContain(nativeResult.fileUri);
    expect(deleted.some((uri) => uri.includes('.rasterizer/key-'))).toBe(true);
    await view.unmount();
  });

  it('leaves an unkeyed native tile as the native file', async () => {
    const { view, window, canvas } = await loadPage();
    connect(window);
    let result: unknown;
    await act(async () => {
      void view.result.current({ source, pageIndex: 0, crop, nativePage }).then((r) => {
        result = r;
      });
    });
    await settle();
    expect(result).toMatchObject({ fileUri: nativeResult.fileUri });
    expect(mockCopyToServed).not.toHaveBeenCalled();
    expect(canvas.writes).toHaveLength(0);
    await view.unmount();
  });

  it('falls back to a keyed pdf.js render of that crop when the page cannot key the tile', async () => {
    const { view, window, canvas } = await loadPage();
    connect(window);
    mockCopyToServed.mockRejectedValueOnce(new Error('disk full'));
    let result: unknown;
    await act(async () => {
      void view.result
        .current({ source, pageIndex: 0, crop, whiteKey: 4, nativePage })
        .then((r) => {
          result = r;
        });
    });
    await settle();
    expect(mockRenderNative).toHaveBeenCalledTimes(1);
    expect(mockDeleteNative).toHaveBeenCalledWith(nativeResult.fileUri);
    // pdf.js painted and keyed it instead.
    expect(result).toMatchObject({ pngDataUri: 'data:image/png;base64,PNG' });
    expect(canvas.writes).toHaveLength(1);
    await view.unmount();
  });

  it('sends the level as a strength with the native page attached', async () => {
    const { view } = await loadPage();
    const pending = view.result
      .current({ source, pageIndex: 0, whiteKey: 4, nativePage })
      .catch(() => undefined);
    const injected = String(mockInject.mock.calls.at(-1)?.[0] ?? '');
    expect(injected).toContain('"expectedPageWidthPt":1000');
    expect(injected).toContain('{"whiteKey":1}); true;');
    await view.unmount();
    await pending;
  });
});

it.each([
  [1, 0.25],
  [2, 0.5],
  [3, 0.75],
] as const)('sends slider stop %d as strength %d', async (whiteKey, strength) => {
  const { view } = await loadPage();
  const source = { url: 'http://127.0.0.1:8080/maps/m.pdf' };
  const pending = view.result.current({ source, pageIndex: 0, whiteKey }).catch(() => undefined);
  const injected = String(mockInject.mock.calls.at(-1)?.[0] ?? '');
  expect(injected).toContain(`{"whiteKey":${strength}}); true;`);
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
