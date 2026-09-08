import { runInNewContext } from 'node:vm';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { PdfRasterizerProvider, usePdfRasterizer, usePdfRasterizerServer } from './PdfRasterizer';
import { deleteNativePdfOutput, nativePdfAvailable, renderNativePdfCrop } from '@data/nativePdf';

const mockInject = jest.fn();
const mockDownloadAsset = jest.fn(async () => ({ localUri: 'file://asset' }));
let mockProps: {
  onContentProcessDidTerminate?: () => void;
  onRenderProcessGone?: () => void;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  onError: (event: { nativeEvent: { url: string; description: string } }) => void;
};
let mockMounts = 0;
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(props: typeof mockProps, ref) {
      mockProps = props;
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
      React.useEffect(() => {
        mockMounts += 1;
      }, []);
      return null;
    }),
  };
});
jest.mock('../../../assets/pdfjs/pdf.legacy.min.js.pdfjs', () => 1);
jest.mock('../../../assets/pdfjs/pdf.worker.legacy.min.js.pdfjs', () => 2);
jest.mock('expo-asset', () => ({
  Asset: { fromModule: () => ({ downloadAsync: mockDownloadAsset }) },
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
  writeServedText: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const request = { source: { base64: 'PDF' }, pageIndex: 0 };
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
);
async function ready() {
  await act(async () => {
    mockProps.onMessage({ nativeEvent: { data: JSON.stringify({ id: '__ready__', ok: true }) } });
  });
}
const renders = () =>
  mockInject.mock.calls.filter(([script]) => String(script).includes('window.__pdfRender'));

beforeEach(() => {
  jest.useFakeTimers();
  mockMounts = 0;
  mockDownloadAsset.mockReset().mockResolvedValue({ localUri: 'file://asset' });
});
afterEach(() => jest.useRealTimers());

it('settles server readiness when unmounted before PDF.js assets finish loading', async () => {
  mockDownloadAsset.mockImplementation(() => new Promise(() => {}));
  const view = await renderHook(usePdfRasterizerServer, { wrapper });
  const settled = jest.fn();
  const origin = view.result.current().then(settled);
  await view.unmount();
  await act(async () => {});
  expect(settled).toHaveBeenCalledWith(null);
  await origin;
});

it('rejects work submitted after unmount without allocating a render timeout', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const rasterize = view.result.current;
  await view.unmount();
  const timers = jest.getTimerCount();
  const rejected = jest.fn();
  const pending = rasterize(request).catch(rejected);
  expect(jest.getTimerCount()).toBe(timers);
  await act(async () => {});
  expect(rejected).toHaveBeenCalledWith(new Error('PdfRasterizer: provider unmounted'));
  expect(renders()).toHaveLength(0);
  await pending;
});

it('removes a request that expires while the engine is still loading', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const expired = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  const next = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(15_000);
  });
  expect(await expired).toBeInstanceOf(Error);
  await ready();
  expect(renders()).toHaveLength(1);
  expect(renders()[0]?.[0]).toContain('req-2');
  await view.unmount();
  await next;
});

it('replaces a timed-out engine before starting another render', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const retiredMessage = mockProps.onMessage;
  const first = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  const next = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(15_000);
  });
  expect(await first).toBeInstanceOf(Error);
  expect(mockMounts).toBe(2);
  expect(renders()).toHaveLength(1);
  await act(async () => {
    retiredMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-1', ok: false, error: 'late failure' }) },
    });
  });
  expect(renders()).toHaveLength(1);
  await ready();
  expect(renders()).toHaveLength(2);
  expect(renders()[1]?.[0]).toContain('req-2');
  const result = {
    pngDataUri: 'data:image/png;base64,PNG',
    widthPx: 2048,
    heightPx: 1024,
    pageWidthPt: 100,
    pageHeightPt: 50,
    pageCount: 1,
    loadMs: 1,
    renderMs: 2,
  };
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-2', ok: true, ...result }) },
    });
  });
  expect(await next).toEqual(result);
  await view.unmount();
});

it.each([{ base64: 'PDF' }, { url: 'http://127.0.0.1:8080/maps/test.pdf' }])(
  'forwards a requested crop to the engine with source %j',
  async (source) => {
    const view = await renderHook(usePdfRasterizer, { wrapper });
    await ready();
    const crop = { x0: 0.25, y0: 0.5, x1: 0.5, y1: 0.75 };
    const pending = view.result.current({ ...request, source, crop }).catch(() => undefined);
    expect(renders()[0]?.[0]).toContain(JSON.stringify(crop));
    await view.unmount();
    await pending;
  },
);

it('gives a dispatched request a full render budget after engine startup', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const rejected = jest.fn();
  const pending = view.result.current(request).catch(rejected);
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  await ready();
  await act(async () => {
    jest.advanceTimersByTime(16_000);
  });
  expect(rejected).not.toHaveBeenCalled();
  expect(mockMounts).toBe(1);
  await act(async () => {
    jest.advanceTimersByTime(29_000);
  });
  expect(rejected).toHaveBeenCalledTimes(1);
  await view.unmount();
  await pending;
});

it.each([false, true])(
  'waits for crop document destruction (cleanup failure: %s)',
  async (fail) => {
    const view = await renderHook(usePdfRasterizer, { wrapper });
    const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
    expect(script).toBeDefined();
    const posted: Record<string, unknown>[] = [];
    const draws: Record<string, unknown>[] = [];
    const ctx = { fillStyle: '', fillRect: jest.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toDataURL: () => 'data:image/png;base64,PNG',
    };
    const page = {
      getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => {
        expect(rotation).toBe(0);
        return { width: 1000 * scale, height: 800 * scale };
      },
      render: (args: Record<string, unknown>) => {
        draws.push({ ...args, width: canvas.width, height: canvas.height });
        return { promise: Promise.resolve() };
      },
    };
    const doc = { numPages: 1, getPage: async () => page, cleanup: jest.fn() };
    let finishDestroy!: () => void;
    const destroyed = new Promise<void>((resolve, reject) => {
      finishDestroy = () => (fail ? reject(new Error('cleanup failed')) : resolve());
    });
    const window = {
      pdfjsLib: {
        GlobalWorkerOptions: { workerSrc: '' },
        getDocument: () => ({ promise: Promise.resolve(doc), destroy: () => destroyed }),
      },
      ReactNativeWebView: { postMessage: (message: string) => posted.push(JSON.parse(message)) },
      __pdfRender: undefined as
        undefined | ((id: string, page: number, width: number, url: string, crop: object) => void),
    };
    runInNewContext(script!, {
      window,
      document: { getElementById: () => canvas },
      setTimeout,
      clearTimeout,
    });
    await act(async () => {
      window.__pdfRender!('crop', 0, 1000, 'http://localhost/maps/a.pdf', {
        x0: 0.25,
        y0: 0.5,
        x1: 0.5,
        y1: 0.75,
      });
    });
    expect(draws[0]).toMatchObject({
      width: 1000,
      height: 800,
      transform: [1, 0, 0, 1, -1000, -1600],
    });
    expect(posted.some((message) => message.id === 'crop')).toBe(false);
    await act(async () => {
      finishDestroy();
    });
    expect(posted.at(-1)).toMatchObject(
      fail
        ? {
            id: 'crop',
            ok: false,
            resetEngine: true,
          }
        : {
            id: 'crop',
            ok: true,
            pageWidthPt: 1000,
            pageHeightPt: 800,
            widthPx: 1000,
            heightPx: 800,
          },
    );
    expect(canvas.width).toBe(1);
    await view.unmount();
  },
);

it('replaces the engine after cleanup failure before dispatching waiting work', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(request).catch(() => undefined);
  const next = view.result.current(request).catch(() => undefined);
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          id: 'req-1',
          ok: false,
          error: 'cleanup failed',
          resetEngine: true,
        }),
      },
    });
  });
  expect(mockMounts).toBe(2);
  expect(renders()).toHaveLength(1);
  await ready();
  expect(renders()).toHaveLength(2);
  await view.unmount();
  await Promise.all([first, next]);
});

jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: jest.fn(() => true),
  renderNativePdfCrop: jest.fn(),
  deleteNativePdfOutput: jest.fn(),
}));
const nativeRequest = {
  ...request,
  crop: { x0: 0.25, y0: 0.25, x1: 0.5, y1: 0.5 },
  nativePage: {
    fileUri: 'file:///map.pdf',
    revision: 'v1',
    expectedPageWidthPt: 1000,
    expectedPageHeightPt: 800,
  },
};
const nativeResult = {
  fileUri: 'file:///detail.png',
  widthPx: 1000,
  heightPx: 800,
  pageWidthPt: 1000,
  pageHeightPt: 800,
  pageCount: 1,
  loadMs: 1,
  renderMs: 2,
};
async function handoff(id = 'req-1') {
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          id,
          ok: true,
          kind: 'native-geometry',
          pageWidthPt: 1000,
          pageHeightPt: 800,
        }),
      },
    });
  });
}
it('hands validated geometry to native and resolves a file without a base64 PNG', async () => {
  jest.mocked(renderNativePdfCrop).mockResolvedValue(nativeResult);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const pending = view.result.current(nativeRequest);
  await handoff();
  expect(renderNativePdfCrop).toHaveBeenCalledWith(
    expect.objectContaining({ fileUri: 'file:///map.pdf', crop: nativeRequest.crop }),
  );
  await expect(pending).resolves.toEqual(nativeResult);
  await view.unmount();
});
it.each(['timeout', 'unmount'] as const)(
  'deletes late native output after %s without overlapping renders',
  async (reason) => {
    let finish!: (result: typeof nativeResult) => void;
    jest.mocked(renderNativePdfCrop).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = await renderHook(usePdfRasterizer, { wrapper });
    await ready();
    const pending = view.result.current(nativeRequest).catch((error: Error) => error);
    await handoff();
    if (reason === 'unmount') await view.unmount();
    else {
      await act(async () => {
        jest.advanceTimersByTime(45_000);
      });
      expect(mockMounts).toBe(1);
    }
    expect(await pending).toBeInstanceOf(Error);
    const next =
      reason === 'timeout' ? view.result.current(request).catch(() => undefined) : undefined;
    expect(renders()).toHaveLength(1);
    await act(async () => {
      finish(nativeResult);
    });
    expect(deleteNativePdfOutput).toHaveBeenCalledWith(nativeResult.fileUri);
    if (reason === 'timeout') {
      expect(renders()).toHaveLength(2);
      await view.unmount();
      await next;
    }
  },
);

it.each([
  { rotate: 0, userUnit: 1, pageView: [0, 0, 1000, 800], eligible: true, crop: nativeRequest.crop },
  {
    rotate: 90,
    userUnit: 1,
    pageView: [0, 0, 1000, 800],
    eligible: false,
    crop: nativeRequest.crop,
  },
  {
    rotate: 0,
    userUnit: 2,
    pageView: [0, 0, 1000, 800],
    eligible: false,
    crop: nativeRequest.crop,
  },
  {
    rotate: 0,
    userUnit: 1,
    pageView: [10, 0, 1010, 800],
    eligible: false,
    crop: nativeRequest.crop,
  },
  { rotate: 0, userUnit: 1, pageView: [0, 0, 900, 800], eligible: false, crop: nativeRequest.crop },
  { rotate: 0, userUnit: 1, pageView: [0, 0, 1000, 800], eligible: true, crop: null },
])(
  'guards native geometry and releases PDF.js before handoff: %j',
  async ({ rotate, userUnit, pageView, eligible, crop }) => {
    const view = await renderHook(usePdfRasterizer, { wrapper });
    const html = jest.mocked(writeServedText).mock.calls.at(-1)![1];
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
    const posted: { id: string; kind?: string }[] = [];
    const draw = jest.fn(() => ({ promise: Promise.resolve() }));
    let release!: () => void;
    const destruction = new Promise<void>((resolve) => {
      release = resolve;
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect: () => {} }),
      toDataURL: () => 'data:image/png;base64,PNG',
    };
    const window = {
      pdfjsLib: {
        GlobalWorkerOptions: {},
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              rotate,
              userUnit,
              view: pageView,
              getViewport: ({ scale }: { scale: number }) => ({
                width: 1000 * scale,
                height: 800 * scale,
              }),
              render: draw,
            }),
          }),
          destroy: () => destruction,
        }),
      },
      ReactNativeWebView: { postMessage: (message: string) => posted.push(JSON.parse(message)) },
      __pdfRender: undefined as undefined | ((...args: unknown[]) => void),
    };
    runInNewContext(script, {
      window,
      document: { getElementById: () => canvas },
      setTimeout,
      clearTimeout,
    });
    await act(async () => {
      window.__pdfRender!(
        'geometry',
        0,
        1000,
        'http://localhost/maps/a.pdf',
        crop,
        nativeRequest.nativePage,
      );
    });
    expect(posted.filter((message) => message.id === 'geometry')).toEqual([]);
    expect(draw).toHaveBeenCalledTimes(eligible ? 0 : 1);
    await act(async () => {
      release();
    });
    expect(posted.at(-1)?.kind).toBe(eligible ? 'native-geometry' : undefined);
    await view.unmount();
  },
);

it('keeps old binaries on PDF.js even when native page metadata was supplied', async () => {
  jest.mocked(nativePdfAvailable).mockReturnValueOnce(false);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const pending = view.result.current(nativeRequest).catch(() => undefined);
  expect(renders()[0]?.[0]).not.toContain('expectedPageWidthPt');
  expect(renderNativePdfCrop).not.toHaveBeenCalled();
  await view.unmount();
  await pending;
});
it('reports native failure without a slow PDF.js retry and releases the next request', async () => {
  jest.mocked(renderNativePdfCrop).mockRejectedValue(new Error('native failure'));
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const pending = view.result.current(nativeRequest).catch((error: Error) => error);
  const next = view.result.current(request).catch(() => undefined);
  await handoff();
  expect(await pending).toEqual(new Error('native failure'));
  expect(renders()).toHaveLength(2);
  expect(renders()[1]?.[0]).toContain('req-2');
  await view.unmount();
  await next;
});
it('rearms the timeout after geometry validation before starting native work', async () => {
  let finish!: (result: typeof nativeResult) => void;
  jest.mocked(renderNativePdfCrop).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const rejected = jest.fn();
  const pending = view.result.current(nativeRequest).catch(rejected);
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  await handoff();
  await act(async () => {
    jest.advanceTimersByTime(20_000);
  });
  expect(rejected).not.toHaveBeenCalled();
  await act(async () => {
    finish(nativeResult);
  });
  await expect(pending).resolves.toEqual(nativeResult);
  await view.unmount();
});

it('retries a transient served-page load failure without losing URL rendering', async () => {
  const view = await renderHook(
    () => ({ rasterize: usePdfRasterizer(), serverOrigin: usePdfRasterizerServer() }),
    { wrapper },
  );
  await ready();
  await act(async () => {
    mockProps.onError({ nativeEvent: { url: '', description: 'temporary load failure' } });
  });
  expect(await view.result.current.serverOrigin()).toBe('http://127.0.0.1:8080');
  expect(mockMounts).toBe(2);
  const pending = view.result.current
    .rasterize({ ...request, source: { url: 'http://127.0.0.1:8080/maps/test.pdf' } })
    .catch((error: Error) => error);
  expect(renders()).toHaveLength(0);
  await ready();
  expect(renders()).toHaveLength(1);
  const { fileUri: _fileUri, ...metadata } = nativeResult;
  const rendered = { ...metadata, pngDataUri: 'data:image/png;base64,PNG' };
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-1', ok: true, ...rendered }) },
    });
  });
  expect(await pending).toEqual(rendered);
  await view.unmount();
});

it('keeps native ownership through served-page fallback until late output is disposed', async () => {
  let finish!: (result: typeof nativeResult) => void;
  jest.mocked(renderNativePdfCrop).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const native = view.result.current(nativeRequest).catch((error: Error) => error);
  await handoff();
  const next = view.result.current(request).catch(() => undefined);
  const third = view.result.current(request).catch(() => undefined);
  await act(async () => {
    mockProps.onError({ nativeEvent: { url: '', description: 'server lost' } });
  });
  await act(async () => {
    mockProps.onError({ nativeEvent: { url: '', description: 'server still lost' } });
  });
  expect(await native).toBeInstanceOf(Error);
  await ready();
  expect(renders()).toHaveLength(1);
  await act(async () => {
    finish(nativeResult);
  });
  expect(deleteNativePdfOutput).toHaveBeenCalledWith(nativeResult.fileUri);
  expect(renders()).toHaveLength(2);
  expect(renders()[1]?.[0]).toContain('req-2');
  await view.unmount();
  await Promise.all([next, third]);
});

it('reuses successful verified geometry for another crop without WebView dispatch', async () => {
  jest.mocked(renderNativePdfCrop).mockResolvedValue(nativeResult);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(nativeRequest);
  await handoff();
  await first;
  const second = view.result
    .current({ ...nativeRequest, crop: { ...nativeRequest.crop, x0: 0.2 } })
    .catch(() => undefined);
  await act(async () => {});
  expect(renders()).toHaveLength(1);
  expect(renderNativePdfCrop).toHaveBeenCalledTimes(2);
  await expect(second).resolves.toEqual(nativeResult);
  await view.unmount();
});
it('requires a fresh probe when the document revision changes', async () => {
  jest.mocked(renderNativePdfCrop).mockResolvedValue(nativeResult);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(nativeRequest);
  await handoff();
  await first;
  const second = view.result
    .current({ ...nativeRequest, nativePage: { ...nativeRequest.nativePage, revision: 'v2' } })
    .catch(() => undefined);
  expect(renders()).toHaveLength(2);
  expect(renderNativePdfCrop).toHaveBeenCalledTimes(1);
  await view.unmount();
  await second;
});

it('bounds verified pages to sixteen entries and revalidates the oldest eviction', async () => {
  jest.mocked(renderNativePdfCrop).mockResolvedValue(nativeResult);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  for (let i = 0; i < 17; i++) {
    const pending = view.result.current({
      ...nativeRequest,
      nativePage: { ...nativeRequest.nativePage, revision: String(i) },
    });
    await handoff(`req-${i + 1}`);
    await pending;
  }
  const pending = view.result
    .current({ ...nativeRequest, nativePage: { ...nativeRequest.nativePage, revision: '0' } })
    .catch(() => undefined);
  expect(renders()).toHaveLength(18);
  expect(renderNativePdfCrop).toHaveBeenCalledTimes(17);
  await view.unmount();
  await pending;
});
it('invalidates verified geometry after a cached native render fails', async () => {
  jest
    .mocked(renderNativePdfCrop)
    .mockResolvedValueOnce(nativeResult)
    .mockRejectedValueOnce(new Error('bad page'));
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(nativeRequest);
  await handoff();
  await first;
  await expect(view.result.current(nativeRequest)).rejects.toThrow('bad page');
  expect(renders()).toHaveLength(1);
  const retry = view.result.current(nativeRequest).catch(() => undefined);
  expect(renders()).toHaveLength(2);
  await view.unmount();
  await retry;
});
it('invalidates a cached render on timeout and holds the queue until its native completion', async () => {
  let finish!: (result: typeof nativeResult) => void;
  jest
    .mocked(renderNativePdfCrop)
    .mockResolvedValueOnce(nativeResult)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(nativeRequest);
  await handoff();
  await first;
  const timed = view.result.current(nativeRequest).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(45_000);
  });
  expect(await timed).toBeInstanceOf(Error);
  const retry = view.result.current(nativeRequest).catch(() => undefined);
  expect(renders()).toHaveLength(1);
  await act(async () => {
    finish(nativeResult);
  });
  expect(deleteNativePdfOutput).toHaveBeenCalledWith(nativeResult.fileUri);
  expect(renders()).toHaveLength(2);
  await view.unmount();
  await retry;
});

it('keeps portrait sampling in the WebView within the shared three-megapixel budget', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const definition = html.match(/function cropGeometry\([\s\S]*?\n  }/)?.[0];
  expect(definition).toBeDefined();
  const geometry = runInNewContext(
    `${definition}; cropGeometry(1320, 2600, 1320, {x0:0,y0:0,x1:1,y1:1})`,
  ) as { widthPx: number; heightPx: number };
  expect(geometry.widthPx).toBe(1263);
  expect(geometry.heightPx).toBe(2489);
  expect(geometry.widthPx * geometry.heightPx).toBeLessThanOrEqual(3 * 1024 * 1024);
  await view.unmount();
});

it('retries unsupported native pages through PDF.js under the same request without overlapping queued work', async () => {
  jest
    .mocked(renderNativePdfCrop)
    .mockRejectedValue(
      Object.assign(new Error('not a single JPEG'), { code: 'E_PDF_UNSUPPORTED' }),
    );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(nativeRequest).catch((error: Error) => error);
  const next = view.result.current(request).catch(() => undefined);
  await handoff();
  expect(renders()).toHaveLength(2);
  expect(renders()[1]?.[0]).toContain('req-1');
  expect(renders()[1]?.[0]).not.toContain('expectedPageWidthPt');
  expect(renderNativePdfCrop).toHaveBeenCalledTimes(1);
  const { fileUri: _drop, ...metadata } = nativeResult;
  const png = { ...metadata, pngDataUri: 'data:image/png;base64,FALLBACK' };
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-1', ok: true, ...png }) },
    });
  });
  await expect(first).resolves.toEqual(png);
  expect(renders()).toHaveLength(3);
  expect(renders()[2]?.[0]).toContain('req-2');
  await view.unmount();
  await next;
});
it('does not resurrect timed-out native work when unsupported is reported late', async () => {
  let fail!: (error: Error) => void;
  jest.mocked(renderNativePdfCrop).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(nativeRequest).catch((error: Error) => error);
  await handoff();
  await act(async () => {
    jest.advanceTimersByTime(45_000);
  });
  expect(await first).toBeInstanceOf(Error);
  const next = view.result.current(request).catch(() => undefined);
  await act(async () => {
    fail(Object.assign(new Error('unsupported'), { code: 'E_PDF_UNSUPPORTED' }));
  });
  expect(renders()).toHaveLength(2);
  expect(renders()[1]?.[0]).toContain('req-2');
  await view.unmount();
  await next;
});

// Content-process loss is a separate native event: it need not emit onError
// or another onLoadStart. A dead idle engine must recover without an app restart.
it.each(['onContentProcessDidTerminate', 'onRenderProcessGone'] as const)(
  'recovers from %s and renders the next map without waiting for timeouts',
  async (event) => {
    const view = await renderHook(usePdfRasterizer, { wrapper });
    await ready();
    const failed = view.result.current(request).catch((error: Error) => error);
    const next = view.result.current(request).catch((error: Error) => error);
    await act(async () => mockProps[event]?.());
    expect(mockMounts).toBe(2);
    expect(await failed).toBeInstanceOf(Error);
    expect(renders()).toHaveLength(1);
    await ready();
    expect(renders()).toHaveLength(2);
    await act(async () => {
      mockProps.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            id: 'req-2',
            ok: true,
            pngDataUri: 'data:image/png;base64,RECOVERED',
            widthPx: 100,
            heightPx: 100,
            pageWidthPt: 100,
            pageHeightPt: 100,
            pageCount: 1,
            loadMs: 1,
            renderMs: 1,
          }),
        },
      });
    });
    await expect(next).resolves.toMatchObject({ pngDataUri: 'data:image/png;base64,RECOVERED' });
    await view.unmount();
  },
);

it('replaces an idle dead content process before accepting the next map', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  await act(async () => mockProps.onContentProcessDidTerminate?.());
  const next = view.result.current(request).catch(() => undefined);
  expect(renders()).toHaveLength(0);
  expect(mockMounts).toBe(2);
  await ready();
  expect(renders()).toHaveLength(1);
  await view.unmount();
  await next;
});

it('recovers a non-ready engine after a queued startup request expires', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  const first = view.result.current(request).catch((error: Error) => error);
  await act(async () => {
    jest.advanceTimersByTime(45_000);
  });
  expect(await first).toBeInstanceOf(Error);
  expect(mockMounts).toBe(2);
  const next = view.result.current(request).catch(() => undefined);
  await ready();
  expect(renders()).toHaveLength(1);
  await view.unmount();
  await next;
});

it('keeps an active native render exclusive when its idle WebView process dies', async () => {
  let finish!: (result: typeof nativeResult) => void;
  jest.mocked(renderNativePdfCrop).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const native = view.result.current(nativeRequest);
  await handoff();
  const next = view.result.current(request).catch(() => undefined);
  await act(async () => mockProps.onContentProcessDidTerminate?.());
  expect(mockMounts).toBe(2);
  await ready();
  expect(renders()).toHaveLength(1);
  await act(async () => {
    finish(nativeResult);
  });
  await expect(native).resolves.toEqual(nativeResult);
  expect(renders()).toHaveLength(2);
  await view.unmount();
  await next;
});

it('ignores readiness and process-loss callbacks from a replaced engine', async () => {
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const retired = mockProps;
  await act(async () => mockProps.onContentProcessDidTerminate?.());
  const next = view.result.current(request).catch(() => undefined);
  await act(async () => {
    retired.onMessage({ nativeEvent: { data: JSON.stringify({ id: '__ready__', ok: true }) } });
  });
  expect(renders()).toHaveLength(0);
  await act(async () => retired.onRenderProcessGone?.());
  expect(mockMounts).toBe(2);
  await ready();
  expect(renders()).toHaveLength(1);
  await view.unmount();
  await next;
});

it('remembers an unsupported native request but probes a new document revision', async () => {
  jest
    .mocked(renderNativePdfCrop)
    .mockRejectedValue(
      Object.assign(new Error('unsupported image encoding'), { code: 'E_PDF_UNSUPPORTED' }),
    );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const first = view.result.current(nativeRequest);
  const second = view.result.current(nativeRequest).catch(() => undefined);
  await handoff();
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          id: 'req-1',
          ok: true,
          pngDataUri: 'data:image/png;base64,FALLBACK',
          widthPx: 100,
          heightPx: 100,
          pageWidthPt: 1000,
          pageHeightPt: 800,
          pageCount: 1,
          loadMs: 1,
          renderMs: 1,
        }),
      },
    });
  });
  await expect(first).resolves.toMatchObject({ pngDataUri: 'data:image/png;base64,FALLBACK' });
  expect(renders()).toHaveLength(3);
  expect(renders()[2]?.[0]).not.toContain('expectedPageWidthPt');
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-2', ok: false, error: 'test finished' }) },
    });
  });
  await second;
  const revised = view.result
    .current({ ...nativeRequest, nativePage: { ...nativeRequest.nativePage, revision: 'changed' } })
    .catch(() => undefined);
  expect(renders()[3]?.[0]).toContain('expectedPageWidthPt');
  await view.unmount();
  await revised;
});

it('bounds unsupported request memory and reprobes the evicted oldest request', async () => {
  jest
    .mocked(renderNativePdfCrop)
    .mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'E_PDF_UNSUPPORTED' }));
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  for (let i = 0; i < 17; i++) {
    const requestId = `req-${i + 1}`;
    const pending = view.result
      .current({
        ...nativeRequest,
        nativePage: {
          ...nativeRequest.nativePage,
          revision: String(i),
        },
      })
      .catch(() => undefined);
    await handoff(requestId);
    await act(async () => {
      mockProps.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            id: requestId,
            ok: false,
            error: 'fallback unavailable',
          }),
        },
      });
    });
    await pending;
  }
  const pending = view.result
    .current({
      ...nativeRequest,
      nativePage: {
        ...nativeRequest.nativePage,
        revision: '0',
      },
    })
    .catch(() => undefined);
  expect(renders().at(-1)?.[0]).toContain('expectedPageWidthPt');
  await view.unmount();
  await pending;
});

it('does not disable a small native crop when a full-page request is unsupported', async () => {
  jest
    .mocked(renderNativePdfCrop)
    .mockRejectedValue(
      Object.assign(new Error('crop exceeds decoder budget'), { code: 'E_PDF_UNSUPPORTED' }),
    );
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const full = view.result
    .current({ ...nativeRequest, crop: { x0: 0, y0: 0, x1: 1, y1: 1 } })
    .catch(() => undefined);
  await handoff();
  await act(async () => {
    mockProps.onMessage({
      nativeEvent: { data: JSON.stringify({ id: 'req-1', ok: false, error: 'fallback failed' }) },
    });
  });
  await full;
  const small = view.result.current(nativeRequest).catch(() => undefined);
  expect(renders().at(-1)?.[0]).toContain('expectedPageWidthPt');
  await view.unmount();
  await small;
});

it('hands an overview to native with a full-page crop after geometry validation', async () => {
  jest.mocked(renderNativePdfCrop).mockResolvedValue(nativeResult);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const pending = view.result
    .current({ ...nativeRequest, crop: null })
    .catch((error: Error) => error);
  expect(renders().at(-1)?.[0]).toContain('expectedPageWidthPt');
  await handoff();
  await expect(pending).resolves.toEqual(nativeResult);
  expect(renderNativePdfCrop).toHaveBeenCalledWith(
    expect.objectContaining({ crop: { x0: 0, y0: 0, x1: 1, y1: 1 } }),
  );
  await view.unmount();
});

it('retains a null PDF.js crop when a native overview is unsupported', async () => {
  jest
    .mocked(renderNativePdfCrop)
    .mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'E_PDF_UNSUPPORTED' }));
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const pending = view.result.current({ ...nativeRequest, crop: null }).catch(() => undefined);
  expect(renders().at(-1)?.[0]).toContain('expectedPageWidthPt');
  await handoff();
  expect(renders()).toHaveLength(2);
  expect(renders().at(-1)?.[0]).toContain('2048, null, null, null)');
  await view.unmount();
  await pending;
});

it('keeps an overview on the original PDF.js budget when native is unavailable', async () => {
  jest.mocked(nativePdfAvailable).mockReturnValueOnce(false);
  const view = await renderHook(usePdfRasterizer, { wrapper });
  await ready();
  const pending = view.result.current({ ...nativeRequest, crop: null }).catch(() => undefined);
  expect(renders().at(-1)?.[0]).toContain('2048, null, null, null)');
  expect(renderNativePdfCrop).not.toHaveBeenCalled();
  await view.unmount();
  await pending;
});
